const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database('cashbyking.db');

// Helper function to generate random referral code
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Create all required tables
function initializeDatabase() {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      upi TEXT NOT NULL,
      password TEXT NOT NULL,
      balance REAL DEFAULT 0,
      profile_photo TEXT DEFAULT '',
      verified_badge INTEGER DEFAULT 0,
      telegram_joined INTEGER DEFAULT 0,
      telegram_reward_claimed INTEGER DEFAULT 0,
      custom_badge_text TEXT DEFAULT '',
      referrer_id INTEGER DEFAULT NULL,
      first_task_completed INTEGER DEFAULT 0,
      phone_verified INTEGER DEFAULT 1,
      email_verified INTEGER DEFAULT 1,
      upi_locked INTEGER DEFAULT 0,
      registered_upi TEXT DEFAULT '',
      banned INTEGER DEFAULT 0,
      banned_reason TEXT DEFAULT '',
      ban_type TEXT DEFAULT 'permanent',
      ban_expiry_date DATETIME DEFAULT NULL,
      referral_code TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add new columns to existing users table (migration)
  // Note: SQLite cannot add UNIQUE columns via ALTER TABLE, so we add without UNIQUE and create index
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ban_type TEXT DEFAULT 'permanent'`);
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE users ADD COLUMN ban_expiry_date DATETIME DEFAULT NULL`);
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE users ADD COLUMN referral_code TEXT`);
  } catch (e) {
    // Column already exists
  }

  // Add missing columns to withdrawals table (migration)
  try {
    db.exec(`ALTER TABLE withdrawals ADD COLUMN payment_method TEXT DEFAULT 'upi'`);
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE withdrawals ADD COLUMN payment_details TEXT DEFAULT ''`);
  } catch (e) {
    // Column already exists
  }

  // Create unique index on referral_code (if not exists)
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`);
  } catch (e) {
    // Index already exists
  }

  // Generate referral codes for existing users who don't have one
  try {
    // Check if referral_code column exists by checking table info
    const columns = db.prepare("PRAGMA table_info(users)").all();
    const hasReferralCode = columns.some(col => col.name === 'referral_code');

    console.log('Referral code column exists:', hasReferralCode);

    if (hasReferralCode) {
      const usersWithoutCodes = db.prepare("SELECT id FROM users WHERE referral_code IS NULL OR referral_code = ''").all();
      console.log('Users without referral codes:', usersWithoutCodes.length);

      const updateCodeStmt = db.prepare('UPDATE users SET referral_code = ? WHERE id = ?');

      for (const user of usersWithoutCodes) {
        let code = generateReferralCode();
        let attempts = 0;

        // Ensure unique code
        while (attempts < 10) {
          const existing = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code);
          if (!existing) {
            try {
              updateCodeStmt.run(code, user.id);
              break;
            } catch (e) {
              console.error('Failed to set referral code:', e);
              code = generateReferralCode();
              attempts++;
            }
          } else {
            code = generateReferralCode();
            attempts++;
          }
        }

        if (attempts >= 10) {
          console.error(`Failed to generate unique referral code for user ${user.id}`);
        }
      }
    }
  } catch (e) {
    console.error('Error generating referral codes:', e);
    console.error('Full error stack:', e.stack);
  }

  // Tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      instruction TEXT NOT NULL,
      thumbnail TEXT DEFAULT '',
      price REAL NOT NULL,
      timer INTEGER DEFAULT 0,
      steps TEXT DEFAULT '',
      task_url TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      initial_likes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add task_url column to existing tasks table (migration)
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_url TEXT DEFAULT ''`);
  } catch (e) {} // Column already exists

  // Pending tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      custom_reason TEXT DEFAULT '',
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `);

  // Completed tasks (to hide from user dashboard)
  db.exec(`
    CREATE TABLE IF NOT EXISTS completed_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      UNIQUE(user_id, task_id)
    )
  `);

  // Transactions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Daily checkin table
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_checkin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      day INTEGER NOT NULL,
      amount REAL NOT NULL,
      claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Referral table
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      referred_id INTEGER NOT NULL,
      reward_amount REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (referrer_id) REFERENCES users(id),
      FOREIGN KEY (referred_id) REFERENCES users(id)
    )
  `);

  // Withdrawals table - drop and recreate to fix schema
  db.exec(`DROP TABLE IF EXISTS withdrawals`);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      payment_method TEXT NOT NULL DEFAULT 'upi',
      payment_details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      request_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      process_date DATETIME,
      admin_notes TEXT DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Task likes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(task_id, user_id)
    )
  `);

  // PWA installs tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pwa_installs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_agent TEXT DEFAULT '',
      installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id)
    )
  `);

  // Add initial like count column to tasks table
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN initial_likes INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists
  }

  // Generate random initial likes for existing tasks without them
  try {
    const tasksWithoutLikes = db.prepare("SELECT id FROM tasks WHERE initial_likes = 0").all();
    const updateStmt = db.prepare('UPDATE tasks SET initial_likes = ? WHERE id = ?');
    
    for (const task of tasksWithoutLikes) {
      const randomLikes = Math.floor(Math.random() * (200 - 50 + 1)) + 50;
      updateStmt.run(randomLikes, task.id);
    }
  } catch (e) {
    console.error('Error setting initial likes:', e);
  }

  console.log('✅ Database initialized successfully');
}

// User operations
const userDb = {
  create: (userData) => {
    // Generate unique referral code
    let referralCode = generateReferralCode();
    let attempts = 0;

    while (attempts < 10) {
      const existing = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referralCode);
      if (!existing) break;
      referralCode = generateReferralCode();
      attempts++;
    }

    const stmt = db.prepare(`
      INSERT INTO users (username, name, email, phone, upi, password, referral_code) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const hashedPassword = bcrypt.hashSync(userData.password, 10);
    return stmt.run(
      userData.username,
      userData.name,
      userData.email,
      userData.phone,
      userData.upi,
      hashedPassword,
      referralCode
    );
  },

  findByEmail: (email) => {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  findByPhone: (phone) => {
    return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  },

  findByUsername: (username) => {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  findById: (id) => {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  findByReferralCode: (code) => {
    return db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code);
  },

  getAll: () => {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  },

  updateBalance: (userId, amount, type, reason) => {
    const stmt = db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?');
    stmt.run(amount, userId);

    // Add transaction
    const tranStmt = db.prepare(`
      INSERT INTO transactions (user_id, type, amount, reason) 
      VALUES (?, ?, ?, ?)
    `);
    tranStmt.run(userId, type, Math.abs(amount), reason);
  },

  setVerifiedBadge: (userId, verified) => {
    return db.prepare('UPDATE users SET verified_badge = ? WHERE id = ?').run(verified, userId);
  },

  setCustomBadge: (userId, text) => {
    return db.prepare('UPDATE users SET custom_badge_text = ? WHERE id = ?').run(text, userId);
  },

  banUser: (userId, banned, reason, banType, expiryDate) => {
    return db.prepare('UPDATE users SET banned = ?, banned_reason = ?, ban_type = ?, ban_expiry_date = ? WHERE id = ?')
      .run(banned, reason, banType || 'permanent', expiryDate || null, userId);
  },

  checkAndLiftExpiredBans: () => {
    // Lift bans that have expired
    return db.prepare(`
      UPDATE users 
      SET banned = 0, banned_reason = '', ban_type = 'permanent', ban_expiry_date = NULL 
      WHERE banned = 1 AND ban_type = 'temporary' AND ban_expiry_date IS NOT NULL AND ban_expiry_date <= CURRENT_TIMESTAMP
    `).run();
  },

  getAnalytics: () => {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const today = db.prepare(`SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = DATE('now')`).get();
    const yesterday = db.prepare(`SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = DATE('now', '-1 day')`).get();
    const totalBalance = db.prepare('SELECT COALESCE(SUM(balance), 0) as total FROM users').get();
    const totalWithdrawals = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = "approved"').get();
    const pendingWithdrawals = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = "pending"').get();
    const activeTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE enabled = 1').get();
    const pendingTasks = db.prepare('SELECT COUNT(*) as count FROM pending_tasks WHERE status = "pending"').get();

    return {
      totalUsers: totalUsers.count,
      usersToday: today.count,
      usersYesterday: yesterday.count,
      totalBalance: totalBalance.total,
      totalWithdrawals: totalWithdrawals.total,
      pendingWithdrawals: pendingWithdrawals.total,
      activeTasks: activeTasks.count,
      pendingTasks: pendingTasks.count
    };
  },

  addBulkBonus: (amount, reason) => {
    const users = db.prepare('SELECT id FROM users WHERE banned = 0').all();
    const updateStmt = db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?');
    const tranStmt = db.prepare(`
      INSERT INTO transactions (user_id, type, amount, reason) 
      VALUES (?, ?, ?, ?)
    `);

    for (const user of users) {
      updateStmt.run(amount, user.id);
      tranStmt.run(user.id, 'admin_credit', Math.abs(amount), reason);
    }

    return users.length;
  },

  deleteUser: (userId) => {
    return db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  },

  updateProfile: (userId, data) => {
    const stmt = db.prepare('UPDATE users SET name = ?, profile_photo = ? WHERE id = ?');
    return stmt.run(data.name, data.profile_photo || '', userId);
  },

  setTelegramJoined: (userId, joined, rewardClaimed) => {
    return db.prepare('UPDATE users SET telegram_joined = ?, telegram_reward_claimed = ? WHERE id = ?')
      .run(joined, rewardClaimed, userId);
  },

  updateLastLogin: (userId) => {
    return db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  },

  lockUpi: (userId, upiId) => {
    return db.prepare('UPDATE users SET upi_locked = 1, registered_upi = ?, upi = ? WHERE id = ?')
      .run(upiId, upiId, userId);
  },

  getStats: (userId) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return null;

    const totalTasks = db.prepare('SELECT COUNT(*) as count FROM completed_tasks WHERE user_id = ?').get(userId);
    const totalReferrals = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(userId);
    const totalEarnings = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total 
      FROM transactions 
      WHERE user_id = ? AND type IN ('task_reward', 'referral', 'daily_checkin', 'telegram_join', 'admin_credit')
    `).get(userId);

    return {
      ...user,
      stats: {
        totalTasksCompleted: totalTasks.count,
        totalReferrals: totalReferrals.count,
        totalEarnings: totalEarnings.total
      }
    };
  }
};

// Task operations
const taskDb = {
  create: (taskData) => {
    // Generate random initial likes between 50-200
    const randomLikes = Math.floor(Math.random() * (200 - 50 + 1)) + 50;
    
    const stmt = db.prepare(`
      INSERT INTO tasks (title, description, instruction, thumbnail, price, timer, steps, task_url, initial_likes) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      taskData.title,
      taskData.description,
      taskData.instruction,
      taskData.thumbnail || '',
      taskData.price,
      taskData.timer || 0,
      taskData.steps || '',
      taskData.task_url || '',
      randomLikes
    );
  },

  getAll: () => {
    return db.prepare('SELECT * FROM tasks WHERE enabled = 1 ORDER BY created_at DESC').all();
  },

  getAllForAdmin: () => {
    return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  },

  getById: (id) => {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  },

  update: (taskId, taskData) => {
    const stmt = db.prepare(`
      UPDATE tasks 
      SET title = ?, description = ?, instruction = ?, thumbnail = ?, price = ?, timer = ?, steps = ?, task_url = ? 
      WHERE id = ?
    `);
    return stmt.run(
      taskData.title,
      taskData.description,
      taskData.instruction,
      taskData.thumbnail,
      taskData.price,
      taskData.timer,
      taskData.steps,
      taskData.task_url || '',
      taskId
    );
  },

  delete: (taskId) => {
    // Delete related records first to avoid foreign key constraint errors
    db.prepare('DELETE FROM task_likes WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM pending_tasks WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM completed_tasks WHERE task_id = ?').run(taskId);
    return db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  },

  setEnabled: (taskId, enabled) => {
    return db.prepare('UPDATE tasks SET enabled = ? WHERE id = ?').run(enabled, taskId);
  },

  getAvailableForUser: (userId) => {
    return db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.enabled = 1 
      AND t.id NOT IN (SELECT task_id FROM completed_tasks WHERE user_id = ?)
      ORDER BY t.created_at DESC
    `).all(userId);
  }
};

// Task likes operations
const taskLikeDb = {
  toggleLike: (taskId, userId) => {
    const existing = db.prepare('SELECT id FROM task_likes WHERE task_id = ? AND user_id = ?').get(taskId, userId);
    
    if (existing) {
      // Unlike
      db.prepare('DELETE FROM task_likes WHERE task_id = ? AND user_id = ?').run(taskId, userId);
      return { liked: false };
    } else {
      // Like
      db.prepare('INSERT INTO task_likes (task_id, user_id) VALUES (?, ?)').run(taskId, userId);
      return { liked: true };
    }
  },

  getLikeCount: (taskId) => {
    const task = db.prepare('SELECT initial_likes FROM tasks WHERE id = ?').get(taskId);
    const userLikes = db.prepare('SELECT COUNT(*) as count FROM task_likes WHERE task_id = ?').get(taskId);
    return (task?.initial_likes || 0) + (userLikes?.count || 0);
  },

  isLikedByUser: (taskId, userId) => {
    const result = db.prepare('SELECT id FROM task_likes WHERE task_id = ? AND user_id = ?').get(taskId, userId);
    return !!result;
  },

  getTasksWithLikes: (userId) => {
    const tasks = taskDb.getAvailableForUser(userId);
    return tasks.map(task => ({
      ...task,
      likeCount: taskLikeDb.getLikeCount(task.id),
      isLiked: taskLikeDb.isLikedByUser(task.id, userId)
    }));
  }
};

// Pending tasks operations
const pendingTaskDb = {
  create: (userId, taskId) => {
    const stmt = db.prepare(`
      INSERT INTO pending_tasks (user_id, task_id) 
      VALUES (?, ?)
    `);
    return stmt.run(userId, taskId);
  },

  getAll: () => {
    return db.prepare(`
      SELECT pt.*, u.username, u.name, t.title as task_title, t.price 
      FROM pending_tasks pt
      JOIN users u ON pt.user_id = u.id
      JOIN tasks t ON pt.task_id = t.id
      ORDER BY pt.submitted_at DESC
    `).all();
  },

  getByUserId: (userId) => {
    return db.prepare(`
      SELECT pt.*, t.title as task_title, t.price 
      FROM pending_tasks pt
      JOIN tasks t ON pt.task_id = t.id
      WHERE pt.user_id = ?
      ORDER BY pt.submitted_at DESC
    `).all(userId);
  },

  approve: (pendingId, userId, taskId, price) => {
    // Update pending task status
    db.prepare('UPDATE pending_tasks SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('approved', pendingId);

    // Add to completed tasks
    db.prepare('INSERT OR IGNORE INTO completed_tasks (user_id, task_id) VALUES (?, ?)')
      .run(userId, taskId);

    // Add balance to user
    userDb.updateBalance(userId, price, 'task_reward', 'Task completed and approved');

    // Check if this is user's first task completion
    const user = db.prepare('SELECT referrer_id, first_task_completed FROM users WHERE id = ?').get(userId);

    if (user && user.referrer_id && user.first_task_completed === 0) {
      // Mark first task as completed
      db.prepare('UPDATE users SET first_task_completed = 1 WHERE id = ?').run(userId);

      // Give additional ₹15 to referrer
      const additionalReward = 15;
      userDb.updateBalance(user.referrer_id, additionalReward, 'referral', 'Referral bonus (first task completed by referred user)');

      // Update referral record
      db.prepare('UPDATE referrals SET reward_amount = reward_amount + ? WHERE referrer_id = ? AND referred_id = ?')
        .run(additionalReward, user.referrer_id, userId);
    }

    return { success: true };
  },

  reject: (pendingId, reason) => {
    return db.prepare('UPDATE pending_tasks SET status = ?, custom_reason = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('rejected', reason, pendingId);
  }
};

// Daily checkin operations
const checkinDb = {
  getLastCheckin: (userId) => {
    return db.prepare(`
      SELECT * FROM daily_checkin 
      WHERE user_id = ? 
      ORDER BY claimed_at DESC 
      LIMIT 1
    `).get(userId);
  },

  claim: (userId, day, amount) => {
    const stmt = db.prepare(`
      INSERT INTO daily_checkin (user_id, day, amount) 
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(userId, day, amount);

    // Add balance
    userDb.updateBalance(userId, amount, 'daily_checkin', `Day ${day} daily check-in`);

    return result;
  },

  getCheckinHistory: (userId) => {
    return db.prepare(`
      SELECT * FROM daily_checkin 
      WHERE user_id = ? 
      ORDER BY day ASC
    `).all(userId);
  }
};

// Transaction operations
const transactionDb = {
  getByUserId: (userId) => {
    return db.prepare(`
      SELECT * FROM transactions 
      WHERE user_id = ? 
      ORDER BY created_at DESC
    `).all(userId);
  },

  getAll: () => {
    return db.prepare(`
      SELECT t.*, u.username, u.name 
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
      LIMIT 100
    `).all();
  }
};

// Referral operations
const referralDb = {
  create: (referrerId, referredId, rewardAmount) => {
    const stmt = db.prepare(`
      INSERT INTO referrals (referrer_id, referred_id, reward_amount) 
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(referrerId, referredId, rewardAmount);

    // Save referrer_id in referred user's record
    db.prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(referrerId, referredId);

    // Add reward to referrer
    if (rewardAmount > 0) {
      userDb.updateBalance(referrerId, rewardAmount, 'referral', 'Referral bonus (instant ₹5)');
    }

    return result;
  },

  getByUserId: (userId) => {
    return db.prepare(`
      SELECT r.*, u.username, u.name 
      FROM referrals r
      JOIN users u ON r.referred_id = u.id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `).all(userId);
  }
};

// Withdrawal operations
const withdrawalDb = {
  create: (userId, amount, paymentMethod, paymentDetails) => {
    const stmt = db.prepare(`
      INSERT INTO withdrawals (user_id, amount, payment_method, payment_details, status, request_date)
      VALUES (?, ?, ?, ?, 'pending', datetime('now'))
    `);
    return stmt.run(userId, amount, paymentMethod, paymentDetails);
  },

  getByUserId: (userId) => {
    return db.prepare(`
      SELECT * FROM withdrawals 
      WHERE user_id = ? 
      ORDER BY request_date DESC
    `).all(userId);
  },

  getAll: () => {
    return db.prepare(`
      SELECT w.*, u.username, u.name, u.email 
      FROM withdrawals w
      JOIN users u ON w.user_id = u.id
      ORDER BY w.request_date DESC
    `).all();
  },

  getPending: () => {
    return db.prepare(`
      SELECT w.*, u.username, u.name, u.email 
      FROM withdrawals w
      JOIN users u ON w.user_id = u.id
      WHERE w.status = 'pending'
      ORDER BY w.request_date ASC
    `).all();
  },

  approve: (withdrawalId, adminNotes) => {
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);

    if (!withdrawal) {
      throw new Error('Withdrawal request not found');
    }

    if (withdrawal.status !== 'pending') {
      throw new Error('Withdrawal already processed');
    }

    const updateStmt = db.prepare(`
      UPDATE withdrawals 
      SET status = 'approved', process_date = CURRENT_TIMESTAMP, admin_notes = ? 
      WHERE id = ? AND status = 'pending'
    `);
    const result = updateStmt.run(adminNotes || 'Approved by admin', withdrawalId);

    if (result.changes === 0) {
      throw new Error('Failed to approve withdrawal');
    }

    userDb.updateBalance(withdrawal.user_id, -withdrawal.amount, 'withdrawal', 'Withdrawal approved');

    // Lock UPI after first successful withdrawal
    const user = db.prepare('SELECT upi_locked FROM users WHERE id = ?').get(withdrawal.user_id);
    if (user && !user.upi_locked) {
      userDb.lockUpi(withdrawal.user_id, withdrawal.payment_details);
    }

    return { success: true };
  },

  reject: (withdrawalId, adminNotes) => {
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);

    if (!withdrawal) {
      throw new Error('Withdrawal request not found');
    }

    if (withdrawal.status !== 'pending') {
      throw new Error('Can only reject pending withdrawals');
    }

    const result = db.prepare(`
      UPDATE withdrawals 
      SET status = 'rejected', process_date = CURRENT_TIMESTAMP, admin_notes = ? 
      WHERE id = ? AND status = 'pending'
    `).run(adminNotes || 'Rejected by admin', withdrawalId);

    if (result.changes === 0) {
      throw new Error('Failed to reject withdrawal');
    }

    return result;
  },

  getPendingTotalByUser: (userId) => {
    const result = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total 
      FROM withdrawals 
      WHERE user_id = ? AND status = 'pending'
    `).get(userId);
    return result.total;
  }
};

// PWA install tracking operations
const pwaInstallDb = {
  track: (userId, userAgent) => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO pwa_installs (user_id, user_agent) 
      VALUES (?, ?)
    `);
    return stmt.run(userId, userAgent || '');
  },

  getAll: () => {
    return db.prepare(`
      SELECT p.*, u.username, u.name, u.email, u.phone 
      FROM pwa_installs p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.installed_at DESC
    `).all();
  },

  getStats: () => {
    const total = db.prepare('SELECT COUNT(*) as count FROM pwa_installs').get();
    const today = db.prepare(`SELECT COUNT(*) as count FROM pwa_installs WHERE DATE(installed_at) = DATE('now')`).get();
    const week = db.prepare(`SELECT COUNT(*) as count FROM pwa_installs WHERE DATE(installed_at) >= DATE('now', '-7 days')`).get();
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
    
    const installRate = totalUsers.count > 0 ? ((total.count / totalUsers.count) * 100).toFixed(1) : 0;
    
    return {
      totalInstalls: total.count,
      todayInstalls: today.count,
      weekInstalls: week.count,
      installRate
    };
  }
};

module.exports = {
  initializeDatabase,
  userDb,
  taskDb,
  pendingTaskDb,
  checkinDb,
  transactionDb,
  referralDb,
  withdrawalDb,
  taskLikeDb,
  pwaInstallDb,
  db
};