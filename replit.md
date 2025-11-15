# CashByKing - Earning Platform

## Overview
CashByKing is a comprehensive earning platform designed to provide users with opportunities to earn money through various tasks, supported by a robust admin control system. The project aims to deliver a seamless and engaging user experience with a modern UI, secure authentication, and a dynamic referral program. Its core purpose is to be a fully functional, database-driven website with high market potential as an accessible earning solution.

## User Preferences
I want iterative development.
I want to deploy on Firebase.
I want the agent to use `SweetAlert2` for all notifications instead of `alert()`.
I want the agent to prioritize a modern, glassmorphism UI with dark/light mode support.
I want the agent to focus on making the application fully mobile responsive.
I want the agent to ensure all data is 100% database-driven with real-time polling, avoiding `localStorage` for critical data.
I want the agent to use custom authentication for security and flexibility.
I want the agent to implement a smart referral system with automated bonuses.
I want the agent to ensure a robust admin panel for full control over users, tasks, and withdrawals.
I want the agent to implement a UPI lock system for secure withdrawals.
I want the agent to develop PWA capabilities for a native app experience.
I want the agent to prioritize professional transformation and modernization of all features.
I want the agent to ensure all pages are full-screen with no margins.

## System Architecture

### UI/UX Decisions
The platform features a modern glassmorphism design with `backdrop-filter: blur(20px)` for frosted glass effects, rounded corners (24px `border-radius`), and semi-transparent backgrounds. It supports both dark and light modes across all pages. Animations are smooth, utilizing `cubic-bezier` transitions. The design is mobile-first, ensuring full responsiveness across all devices, with full-screen layouts and no margins. Key UI components include:
- Professional dashboard with live balance updates.
- Compact signup form and task cards for better screen utilization.
- Gradient titles, confetti-style animations, and smooth zoom effects for success popups.
- Enhanced visual hierarchy with improved spacing, typography, and color contrast.
- PWA support with a `manifest.json` and a `service worker (sw.js)` for offline capabilities and caching.

### Technical Implementations
- **Backend**: Node.js with Express.
- **Frontend**: Vanilla HTML, CSS, and JavaScript.
- **Authentication**: Custom session-based authentication using `bcryptjs` for password hashing, with unique constraints on phone and email to prevent duplicate accounts. Sessions are persistent and stored in an SQLite session store.
- **Real-Time Updates**: All critical data is 100% database-driven, with client-side polling every 5 seconds to ensure real-time updates without page reloads.
- **Referral System**: Automated tracking and payout of referral bonuses (₹5 on signup, ₹15 on first task completion by referred user).
- **Task Management**: System for creating, managing, submitting, tracking, and approving tasks.
- **Withdrawal System**: UPI-protected withdrawal process with a minimum threshold of ₹50 and a permanent UPI lock after the first withdrawal to prevent fraud.
- **Admin Panel**: Password-protected interface for user management (balance, badges, ban/unban), task management, withdrawal approval, and pending task approval.
- **Daily Check-in**: Feature offering random rewards (₹1-10) for 7 consecutive days.
- **Badge System**: Admin-assignable verified badges and custom emoji badges displayed on user profiles.

### Feature Specifications
- **Dashboard**: Displays live balance, total earnings, tasks completed, total referrals, profile with badges, and available tasks.
- **User Management**: Admin can manage user balances, assign badges, ban/unban, and delete users.
- **Task Workflow**: Users submit tasks, which are then reviewed and approved by an admin, triggering referral bonuses if applicable.
- **PWA**: Full PWA capability with manifest, service worker for caching static assets (cache-first) and handling API routes (network-only to prevent caching POST requests), and an install prompt.
- **Security**: Password hashing, session-based authentication, admin password protection, input validation, and SQL injection prevention via prepared statements.

### System Design Choices
- **Database**: SQLite (`better-sqlite3`) is used as a file-based database for simplicity and ease of deployment, sufficient for the current scale.
- **Environment Variables**: `ADMIN_PASSWORD` (required) and `SESSION_SECRET` (optional) are used for configuration and security.
- **Error Handling**: Professional error handling is implemented throughout the application, with `SweetAlert2` for user notifications.
- **Mobile Optimization**: All pages are designed for perfect responsiveness, full-screen layouts, and touch-friendly interactions.

## External Dependencies
- **Database**: SQLite (managed by `better-sqlite3`).
- **Frontend Library**: SweetAlert2 (for notifications).
- **Authentication**: bcryptjs (for password hashing).
- **Communication**: WhatsApp (support link), Telegram (channel link).