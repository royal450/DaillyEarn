const express = require('express');
const session = require('express-session');
const SqliteStore = require('connect-sqlite3')(session);
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const { initializeDatabase, userDb, taskDb, pendingTaskDb, checkinDb, transactionDb, referralDb, withdrawalDb, taskLikeDb, pwaInstallDb } = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize database
initializeDatabase();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// Session configuration with SQLite database storage (5 years validity - virtually never expires)
app.use(session({
  store: new SqliteStore({
    db: 'sessions.db',
    dir: './',
    table: 'sessions',
    concurrentDB: true
  }),
  secret: process.env.SESSION_SECRET || 'cashbyking-secret-key-848592',
  resave: false,
  saveUninitialized: false,
  rolling: true, // Session को हर request पर renew करेगा
  cookie: { 
    maxAge: 5 * 365 * 24 * 60 * 60 * 1000, // 5 years - virtually never expires
    httpOnly: true,
    secure: false // Production में true करें (HTTPS के साथ)
  }
}));

// Serve static files with cache control headers
app.use(express.static(__dirname, {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Check and lift expired bans on every request
app.use((req, res, next) => {
  try {
    userDb.checkAndLiftExpiredBans();
  } catch (e) {}
  next();
});

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  
  const user = userDb.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({ success: false, message: 'User not found' });
  }
  
  if (user.banned) {
    return res.status(403).json({ success: false, message: user.banned_reason || 'Account banned' });
  }
  
  req.user = user;
  next();
};

// Admin authentication middleware
const requireAdmin = (req, res, next) => {
  const adminPassword = req.headers['admin-password'] || req.body.adminPassword;
  const validAdminPassword = process.env.ADMIN_PASSWORD || '848592'; // Default fallback password
  
  if (adminPassword !== validAdminPassword) {
    return res.status(403).json({ success: false, message: 'Invalid admin password' });
  }
  next();
};

// ==================== AUTH ROUTES ====================

// Check if user is authenticated
app.get('/api/auth/check', (req, res) => {
  try {
    if (req.session && req.session.userId) {
      const user = userDb.findById(req.session.userId);
      if (user && !user.banned) {
        // हर visit पर session को touch करें (rolling: true इसे auto renew करेगा)
        req.session.touch();
        
        // Last login update करें
        userDb.updateLastLogin(user.id);
        
        return res.json({ 
          success: true, 
          authenticated: true, 
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            email: user.email,
            balance: user.balance,
            verified_badge: user.verified_badge,
            custom_badge_text: user.custom_badge_text,
            profile_photo: user.profile_photo,
            telegram_joined: user.telegram_joined
          }
        });
      } else if (user && user.banned) {
        // Banned user का session destroy करें
        req.session.destroy();
        return res.json({ success: true, authenticated: false });
      }
    }
    res.json({ success: true, authenticated: false });
  } catch (error) {
    console.error('Auth check error:', error);
    res.json({ success: true, authenticated: false });
  }
});

// Signup
app.post('/api/auth/signup', (req, res) => {
  const { name, email, phone, password, inviteCode } = req.body;
  let { username, upi } = req.body;

  if (!name || !email || !phone || !password) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  // Basic phone validation (allow international formats)
  if (phone.length < 8) {
    return res.json({ success: false, message: 'Invalid phone number' });
  }

  // Auto-generate unique username from email if not provided
  if (!username) {
    const baseUsername = email.split('@')[0];
    username = baseUsername;
    let attempt = 0;
    
    while (userDb.findByUsername(username) && attempt < 100) {
      username = baseUsername + Math.floor(Math.random() * 100000);
      attempt++;
    }
    
    if (attempt >= 100) {
      return res.json({ success: false, message: 'Failed to generate unique username. Please try again.' });
    }
  }

  // Set UPI to pending if not provided (user can update later)
  if (!upi) {
    upi = 'pending';
  }

  // Check if email already exists
  if (userDb.findByEmail(email)) {
    return res.json({ success: false, message: 'This email is already registered. Please login instead.' });
  }

  // Check if phone already exists (prevent duplicate accounts)
  if (userDb.findByPhone(phone)) {
    return res.json({ success: false, message: 'This phone number is already registered. One account per person only!' });
  }

  try {
    const result = userDb.create({ name, email, phone, upi, password, username });
    const newUserId = result.lastInsertRowid;
    
    // Create persistent session (1 year validity)
    req.session.userId = newUserId;
    req.session.createdAt = new Date().toISOString();
    
    // Session को save करें database में
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
      }
    });
    
    // Auto-apply referral if invite code exists
    if (inviteCode) {
      const referrer = userDb.findByReferralCode(inviteCode.toUpperCase());
      if (referrer && referrer.id !== newUserId && !referrer.banned) {
        // Give instant ₹5 to referrer (₹15 more when invited user completes first task)
        const instantReward = 5;
        referralDb.create(referrer.id, newUserId, instantReward);
      }
    }
    
    // Verify referral code was generated
    const newUser = userDb.findById(newUserId);
    console.log('New user created with referral code:', newUser.referral_code);
    
    res.json({ 
      success: true, 
      message: 'Account created successfully! Welcome to CashByKing 🎉',
      userId: newUserId,
      referralCode: newUser.referral_code
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.json({ success: false, message: 'Signup failed: ' + error.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, message: 'Email and password required' });
  }

  const user = userDb.findByEmail(email);
  
  if (!user) {
    return res.json({ success: false, message: 'Invalid email or password' });
  }

  if (user.banned) {
    return res.json({ success: false, message: user.banned_reason || 'Account banned' });
  }

  const validPassword = bcrypt.compareSync(password, user.password);
  
  if (!validPassword) {
    return res.json({ success: false, message: 'Invalid email or password' });
  }

  // Create persistent session (1 year validity)
  req.session.userId = user.id;
  req.session.createdAt = new Date().toISOString();
  
  // Session को save करें database में
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
    }
  });
  
  userDb.updateLastLogin(user.id);
  
  res.json({ 
    success: true, 
    message: 'Welcome back! 🎉',
    userId: user.id
  });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Logged out successfully' });
});

// ==================== USER ROUTES ====================

// Get current user data
app.get('/api/user/me', requireAuth, (req, res) => {
  res.json({ 
    success: true, 
    user: {
      id: req.user.id,
      username: req.user.username,
      name: req.user.name,
      email: req.user.email,
      phone: req.user.phone,
      upi: req.user.upi,
      balance: req.user.balance,
      verified_badge: req.user.verified_badge,
      custom_badge_text: req.user.custom_badge_text,
      profile_photo: req.user.profile_photo,
      telegram_joined: req.user.telegram_joined,
      telegram_reward_claimed: req.user.telegram_reward_claimed,
      upi_locked: req.user.upi_locked,
      registered_upi: req.user.registered_upi,
      referral_code: req.user.referral_code,
      created_at: req.user.created_at
    }
  });
});

// Get user overview/stats for dashboard
app.get('/api/user/overview', requireAuth, (req, res) => {
  try {
    const userStats = userDb.getStats(req.user.id);
    if (!userStats) {
      return res.json({ success: false, message: 'User not found' });
    }
    
    res.json({ 
      success: true,
      user: {
        id: userStats.id,
        username: userStats.username,
        name: userStats.name,
        email: userStats.email,
        phone: userStats.phone,
        balance: userStats.balance,
        verified_badge: userStats.verified_badge,
        custom_badge_text: userStats.custom_badge_text,
        profile_photo: userStats.profile_photo,
        upi_locked: userStats.upi_locked,
        registered_upi: userStats.registered_upi,
        stats: userStats.stats
      }
    });
  } catch (error) {
    console.error('Overview error:', error);
    res.json({ success: false, message: 'Failed to fetch overview' });
  }
});

// Update user profile
app.post('/api/user/update-profile', requireAuth, (req, res) => {
  const { name, profile_photo } = req.body;
  
  try {
    userDb.updateProfile(req.user.id, { name, profile_photo });
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (error) {
    res.json({ success: false, message: 'Update failed: ' + error.message });
  }
});

// Get user transactions
app.get('/api/user/transactions', requireAuth, (req, res) => {
  const transactions = transactionDb.getByUserId(req.user.id);
  res.json({ success: true, transactions });
});

// Telegram join reward
app.post('/api/user/telegram-joined', requireAuth, (req, res) => {
  if (req.user.telegram_reward_claimed) {
    return res.json({ success: false, message: 'Telegram reward already claimed' });
  }
  
  userDb.setTelegramJoined(req.user.id, 1, 0);


// Track PWA install
app.post('/api/user/pwa-install', requireAuth, (req, res) => {
  try {
    const userAgent = req.headers['user-agent'] || '';
    pwaInstallDb.track(req.user.id, userAgent);
    res.json({ success: true, message: 'PWA install tracked' });
  } catch (error) {
    res.json({ success: false, message: 'Tracking failed: ' + error.message });
  }
});

// Get user notifications
app.get('/api/user/notifications', requireAuth, (req, res) => {
  global.userNotifications = global.userNotifications || {};
  const notifications = global.userNotifications[req.user.id] || [];
  res.json({ success: true, notifications });
});

// Mark notification as read
app.post('/api/user/notifications/read', requireAuth, (req, res) => {
  const { notificationId } = req.body;
  global.userNotifications = global.userNotifications || {};
  
  if (global.userNotifications[req.user.id]) {
    const notif = global.userNotifications[req.user.id].find(n => n.id === notificationId);
    if (notif) {
      notif.read = true;
    }
  }
  
  res.json({ success: true });
});

// Clear old notifications (keep only last 50 per user)
function cleanupOldNotifications() {
  global.userNotifications = global.userNotifications || {};
  for (const userId in global.userNotifications) {
    if (global.userNotifications[userId].length > 50) {
      global.userNotifications[userId] = global.userNotifications[userId].slice(-50);
    }
  }
}

// Cleanup every hour
setInterval(cleanupOldNotifications, 60 * 60 * 1000);

  res.json({ success: true, message: 'Telegram join verified! Admin will review and add ₹5 reward.' });
});

// ==================== TASK ROUTES ====================

// Get available tasks for user
app.get('/api/tasks/available', requireAuth, (req, res) => {
  const tasks = taskLikeDb.getTasksWithLikes(req.user.id);
  res.json({ success: true, tasks });
});

// Submit task for review
app.post('/api/tasks/submit', requireAuth, (req, res) => {
  const { taskId } = req.body;
  
  if (!taskId) {
    return res.json({ success: false, message: 'Task ID required' });
  }
  
  try {
    pendingTaskDb.create(req.user.id, taskId);
    res.json({ success: true, message: 'Task submitted for review! You will be notified once approved.' });
  } catch (error) {
    res.json({ success: false, message: 'Submission failed: ' + error.message });
  }
});

// Toggle task like
app.post('/api/tasks/like', requireAuth, (req, res) => {
  const { taskId } = req.body;
  
  if (!taskId) {
    return res.json({ success: false, message: 'Task ID required' });
  }
  
  try {
    const result = taskLikeDb.toggleLike(taskId, req.user.id);
    const likeCount = taskLikeDb.getLikeCount(taskId);
    res.json({ success: true, liked: result.liked, likeCount });
  } catch (error) {
    res.json({ success: false, message: 'Like failed: ' + error.message });
  }
});

// Get user pending tasks
app.get('/api/tasks/pending', requireAuth, (req, res) => {
  const pendingTasks = pendingTaskDb.getByUserId(req.user.id);
  res.json({ success: true, pendingTasks });
});

// ==================== DAILY CHECKIN ROUTES ====================

// Get checkin status
app.get('/api/checkin/status', requireAuth, (req, res) => {
  const lastCheckin = checkinDb.getLastCheckin(req.user.id);
  const history = checkinDb.getCheckinHistory(req.user.id);
  
  let canClaim = true;
  let nextDay = 1;
  
  if (lastCheckin) {
    const lastClaimDate = new Date(lastCheckin.claimed_at);
    const now = new Date();
    const hoursDiff = (now - lastClaimDate) / (1000 * 60 * 60);
    
    if (hoursDiff < 24) {
      canClaim = false;
    }
    
    if (lastCheckin.day >= 7) {
      nextDay = 1; // Reset to day 1 after 7 days
    } else {
      nextDay = lastCheckin.day + 1;
    }
  }
  
  res.json({ success: true, canClaim, nextDay, history, lastCheckin });
});

// Claim daily reward
app.post('/api/checkin/claim', requireAuth, (req, res) => {
  const lastCheckin = checkinDb.getLastCheckin(req.user.id);
  
  let nextDay = 1;
  if (lastCheckin) {
    const lastClaimDate = new Date(lastCheckin.claimed_at);
    const now = new Date();
    const hoursDiff = (now - lastClaimDate) / (1000 * 60 * 60);
    
    if (hoursDiff < 24) {
      return res.json({ success: false, message: 'You can claim again after 24 hours!' });
    }
    
    if (lastCheckin.day >= 7) {
      nextDay = 1;
    } else {
      nextDay = lastCheckin.day + 1;
    }
  }
  
  // Random amount between 1 and 10
  const amount = Math.floor(Math.random() * 10) + 1;
  
  try {
    checkinDb.claim(req.user.id, nextDay, amount);
    res.json({ success: true, message: `Congratulations! You earned ₹${amount} 🎉`, amount, day: nextDay });
  } catch (error) {
    res.json({ success: false, message: 'Claim failed: ' + error.message });
  }
});

// ==================== REFERRAL ROUTES ====================

// Get user referrals
app.get('/api/referrals/my', requireAuth, (req, res) => {
  const referrals = referralDb.getByUserId(req.user.id);
  res.json({ success: true, referrals });
});

// ==================== WITHDRAWAL ROUTES ====================

// Request withdrawal
app.post('/api/wallet/withdraw', requireAuth, (req, res) => {
  const { amount, paymentMethod, paymentDetails } = req.body;
  
  if (!amount || !paymentMethod || !paymentDetails) {
    return res.json({ success: false, message: 'All fields are required' });
  }
  
  const withdrawAmount = parseFloat(amount);
  
  if (withdrawAmount < 50) {
    return res.json({ success: false, message: 'Minimum withdrawal amount is ₹50' });
  }
  
  const pendingTotal = withdrawalDb.getPendingTotalByUser(req.user.id);
  const availableBalance = req.user.balance - pendingTotal;
  
  if (withdrawAmount > availableBalance) {
    return res.json({ 
      success: false, 
      message: `Insufficient available balance. You have ₹${pendingTotal.toFixed(2)} in pending withdrawals.` 
    });
  }
  
  try {
    withdrawalDb.create(req.user.id, withdrawAmount, paymentMethod, paymentDetails);
    res.json({ success: true, message: 'Withdrawal request submitted! Admin will process it soon.' });
  } catch (error) {
    res.json({ success: false, message: 'Request failed: ' + error.message });
  }
});

// Get user withdrawal history
app.get('/api/wallet/withdrawals', requireAuth, (req, res) => {
  const withdrawals = withdrawalDb.getByUserId(req.user.id);
  res.json({ success: true, withdrawals });
});

// ==================== ADMIN ROUTES ====================

// Get all users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = userDb.getAll();
  res.json({ success: true, users });
});

// Add/remove balance
app.post('/api/admin/user/balance', requireAdmin, (req, res) => {
  const { userId, amount, reason } = req.body;
  
  if (!userId || amount === undefined) {
    return res.json({ success: false, message: 'User ID and amount required' });
  }
  
  try {
    const type = amount > 0 ? 'admin_credit' : 'admin_debit';
    userDb.updateBalance(userId, parseFloat(amount), type, reason || 'Admin adjustment');
    res.json({ success: true, message: 'Balance updated successfully' });
  } catch (error) {
    res.json({ success: false, message: 'Update failed: ' + error.message });
  }
});

// Set verify badge
app.post('/api/admin/user/verify-badge', requireAdmin, (req, res) => {
  const { userId, verified } = req.body;
  
  try {
    userDb.setVerifiedBadge(userId, verified ? 1 : 0);
    res.json({ success: true, message: 'Verify badge updated' });
  } catch (error) {
    res.json({ success: false, message: 'Update failed: ' + error.message });
  }
});

// Set custom badge text
app.post('/api/admin/user/custom-badge', requireAdmin, (req, res) => {
  const { userId, badgeText } = req.body;
  
  try {
    userDb.setCustomBadge(userId, badgeText || '');
    res.json({ success: true, message: 'Custom badge updated' });
  } catch (error) {
    res.json({ success: false, message: 'Update failed: ' + error.message });
  }
});

// Ban/unban user (supports temporary and permanent bans)
app.post('/api/admin/user/ban', requireAdmin, (req, res) => {
  const { userId, banned, reason, banType, banDays } = req.body;
  
  try {
    let expiryDate = null;
    
    if (banned && banType === 'temporary' && banDays) {
      // Calculate expiry date for temporary ban in SQLite-compatible format
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + parseInt(banDays));
      // Format as "YYYY-MM-DD HH:MM:SS" (SQLite format, not ISO 8601)
      expiryDate = expiry.getFullYear() + '-' +
        String(expiry.getMonth() + 1).padStart(2, '0') + '-' +
        String(expiry.getDate()).padStart(2, '0') + ' ' +
        String(expiry.getHours()).padStart(2, '0') + ':' +
        String(expiry.getMinutes()).padStart(2, '0') + ':' +
        String(expiry.getSeconds()).padStart(2, '0');
    }
    
    userDb.banUser(userId, banned ? 1 : 0, reason || '', banType || 'permanent', expiryDate);
    
    let message = banned ? 'User banned' : 'User unbanned';
    if (banned && banType === 'temporary' && banDays) {
      message = `User temporarily banned for ${banDays} days`;
    }
    
    res.json({ success: true, message });
  } catch (error) {
    res.json({ success: false, message: 'Update failed: ' + error.message });
  }
});

// Delete user
app.post('/api/admin/user/delete', requireAdmin, (req, res) => {
  const { userId } = req.body;
  
  try {
    userDb.deleteUser(userId);
    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    res.json({ success: false, message: 'Delete failed: ' + error.message });
  }
});

// Get analytics
app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  try {
    const analytics = userDb.getAnalytics();
    res.json({ success: true, analytics });
  } catch (error) {
    res.json({ success: false, message: 'Failed to fetch analytics: ' + error.message });
  }
});

// Bulk bonus to all users
app.post('/api/admin/bulk-bonus', requireAdmin, (req, res) => {
  const { amount, reason } = req.body;
  
  if (!amount || amount === 0) {
    return res.json({ success: false, message: 'Amount is required' });
  }
  
  try {
    const count = userDb.addBulkBonus(parseFloat(amount), reason || 'Bulk bonus from admin');
    res.json({ success: true, message: `Successfully added ₹${amount} to ${count} users!`, affectedUsers: count });
  } catch (error) {
    res.json({ success: false, message: 'Bulk bonus failed: ' + error.message });
  }
});

// Verify telegram join and give reward
app.post('/api/admin/verify-telegram', requireAdmin, (req, res) => {
  const { userId } = req.body;
  
  const user = userDb.findById(userId);
  if (!user) {
    return res.json({ success: false, message: 'User not found' });
  }
  
  if (user.telegram_reward_claimed) {
    return res.json({ success: false, message: 'Reward already claimed' });
  }
  
  try {
    userDb.updateBalance(userId, 5, 'telegram_join', 'Telegram join reward');
    userDb.setTelegramJoined(userId, 1, 1);
    res.json({ success: true, message: 'Telegram join verified and ₹5 added!' });
  } catch (error) {
    res.json({ success: false, message: 'Verification failed: ' + error.message });
  }
});

// Get all tasks (admin)
app.get('/api/admin/tasks', requireAdmin, (req, res) => {
  const tasks = taskDb.getAllForAdmin();
  res.json({ success: true, tasks });
});

// Create task
app.post('/api/admin/tasks/create', requireAdmin, (req, res) => {
  const { title, description, instruction, thumbnail, price, timer, steps, task_url, sendNotification } = req.body;
  
  if (!title || !description || !instruction || price === undefined) {
    return res.json({ success: false, message: 'Required fields missing' });
  }
  
  try {
    taskDb.create({ title, description, instruction, thumbnail, price, timer, steps, task_url });
    
    let notificationsSent = 0;
    
    // Send notifications to ALL users if requested (including admin and all registered users)
    if (sendNotification) {
      const users = userDb.getAll(); // Gets ALL users from database
      notificationsSent = users.length;
      
      // Initialize global notification storage (persists in server memory)
      if (!global.userNotifications) {
        global.userNotifications = {};
      }
      
      const notificationMessages = [
        `🎉 नया Task आ गया! "${title}" complete करो और ₹${price} कमाओ!`,
        `💰 Fresh Task Available! "${title}" - ₹${price} इनाम तुम्हारा है!`,
        `⚡ Hot Task Alert! "${title}" अभी करो और पाओ ₹${price}!`,
        `🔥 Earning का मौका! "${title}" - आज ही ₹${price} कमाओ!`,
        `✨ नया काम आया! "${title}" पूरा करके ₹${price} पाओ!`,
        `🚀 Task Notification! Complete "${title}" - Get ₹${price} reward!`,
        `💸 नई कमाई! "${title}" task अभी available - ₹${price} जीतो!`,
        `🎯 New Opportunity! "${title}" - Earn ₹${price} now!`,
        `💵 कमाई का नया तरीका! "${title}" - ₹${price} reward मिलेगा!`
      ];
      
      const randomMessage = notificationMessages[Math.floor(Math.random() * notificationMessages.length)];
      
      // Send to ALL users including admin
      users.forEach(user => {
        // Initialize notification array for each user if not exists
        if (!global.userNotifications[user.id]) {
          global.userNotifications[user.id] = [];
        }
        
        // Add notification for EVERY user (including admin user ID 1)
        global.userNotifications[user.id].push({
          id: Date.now() + Math.random() * 1000 + user.id, // Unique ID
          message: randomMessage,
          timestamp: new Date().toISOString(),
          read: false,
          type: 'new_task',
          taskTitle: title,
          taskPrice: price
        });
      });
      
      console.log(`📢 Push notifications sent to ${notificationsSent} users (including admin) for new task: "${title}" (₹${price})`);
      console.log(`📱 Notification example: "${randomMessage}"`);
    }
    
    res.json({ 
      success: true, 
      message: 'Task created successfully',
      notificationsSent 
    });
  } catch (error) {
    res.json({ success: false, message: 'Creation failed: ' + error.message });
  }
});

// Update task
app.post('/api/admin/tasks/update', requireAdmin, (req, res) => {
  const { taskId, title, description, instruction, thumbnail, price, timer, steps, task_url } = req.body;
  
  try {
    taskDb.update(taskId, { title, description, instruction, thumbnail, price, timer, steps, task_url });
    res.json({ success: true, message: 'Task updated successfully' });
  } catch (error) {
    res.json({ success: false, message: 'Update failed: ' + error.message });
  }
});

// Delete task
app.post('/api/admin/tasks/delete', requireAdmin, (req, res) => {
  const { taskId } = req.body;
  
  try {
    taskDb.delete(taskId);
    res.json({ success: true, message: 'Task deleted' });
  } catch (error) {
    res.json({ success: false, message: 'Delete failed: ' + error.message });
  }
});

// Enable/disable task
app.post('/api/admin/tasks/toggle', requireAdmin, (req, res) => {
  const { taskId, enabled } = req.body;
  
  try {
    taskDb.setEnabled(taskId, enabled ? 1 : 0);
    res.json({ success: true, message: enabled ? 'Task enabled' : 'Task disabled' });
  } catch (error) {
    res.json({ success: false, message: 'Update failed: ' + error.message });
  }
});

// Get all pending tasks
app.get('/api/admin/pending-tasks', requireAdmin, (req, res) => {
  const pendingTasks = pendingTaskDb.getAll();
  res.json({ success: true, pendingTasks });
});

// Approve pending task
app.post('/api/admin/pending-tasks/approve', requireAdmin, (req, res) => {
  const { pendingId, userId, taskId, price } = req.body;
  
  try {
    pendingTaskDb.approve(pendingId, userId, taskId, price);
    res.json({ success: true, message: 'Task approved and payment credited!' });
  } catch (error) {
    res.json({ success: false, message: 'Approval failed: ' + error.message });
  }
});

// Reject pending task
app.post('/api/admin/pending-tasks/reject', requireAdmin, (req, res) => {
  const { pendingId, reason } = req.body;
  
  try {
    pendingTaskDb.reject(pendingId, reason || 'Task rejected');
    res.json({ success: true, message: 'Task rejected' });
  } catch (error) {
    res.json({ success: false, message: 'Rejection failed: ' + error.message });
  }
});

// Get all transactions
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const transactions = transactionDb.getAll();
  res.json({ success: true, transactions });
});

// Get all withdrawal requests
app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  const withdrawals = withdrawalDb.getAll();
  res.json({ success: true, withdrawals });
});

// Get PWA installs data (admin)
app.get('/api/admin/pwa-installs', requireAdmin, (req, res) => {
  try {
    const installs = pwaInstallDb.getAll();
    const stats = pwaInstallDb.getStats();
    res.json({ success: true, installs, stats });
  } catch (error) {
    res.json({ success: false, message: 'Failed to fetch PWA installs: ' + error.message });
  }
});

// Approve withdrawal
app.post('/api/admin/withdrawals/approve', requireAdmin, (req, res) => {
  const { withdrawalId, adminNotes } = req.body;
  
  if (!withdrawalId) {
    return res.json({ success: false, message: 'Withdrawal ID required' });
  }
  
  try {
    withdrawalDb.approve(withdrawalId, adminNotes);
    res.json({ success: true, message: 'Withdrawal approved and processed!' });
  } catch (error) {
    res.json({ success: false, message: 'Approval failed: ' + error.message });
  }
});

// Reject withdrawal
app.post('/api/admin/withdrawals/reject', requireAdmin, (req, res) => {
  const { withdrawalId, adminNotes } = req.body;
  
  try {
    withdrawalDb.reject(withdrawalId, adminNotes);
    res.json({ success: true, message: 'Withdrawal rejected' });
  } catch (error) {
    res.json({ success: false, message: 'Rejection failed: ' + error.message });
  }
});

// ==================== HTML ROUTES ====================

app.get('/', (req, res) => {
  try {
    // If user is already authenticated, show dashboard directly
    if (req.session && req.session.userId) {
      const user = userDb.findById(req.session.userId);
      if (user && !user.banned) {
        return res.sendFile(path.join(__dirname, 'dashboard.html'));
      }
    }
    // Otherwise show signup page
    res.sendFile(path.join(__dirname, 'signup.html'));
  } catch (error) {
    console.error('Root route error:', error);
    res.sendFile(path.join(__dirname, 'signup.html'));
  }
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/wallet', (req, res) => {
  res.sendFile(path.join(__dirname, 'wallet.html'));
});

app.get('/transactions', (req, res) => {
  res.sendFile(path.join(__dirname, 'transactions.html'));
});

app.get('/referral', (req, res) => {
  res.sendFile(path.join(__dirname, 'referral.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'settings.html'));
});

app.get('/checkin', (req, res) => {
  res.sendFile(path.join(__dirname, 'checkin.html'));
});

app.get('/pending-tasks', (req, res) => {
  res.sendFile(path.join(__dirname, 'pending-tasks.html'));
});

app.get('/task-detail', (req, res) => {
  res.sendFile(path.join(__dirname, 'task-detail.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ CashByKing server running on http://0.0.0.0:${PORT}`);
});
