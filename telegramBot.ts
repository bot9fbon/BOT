// Confirm strategy wizard button
// --- Sent Tokens Rotating File System ---

import crypto from 'crypto';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import { STRATEGY_FIELDS, buildTokenMessage } from './utils/tokenUtils';
import fetchDefault from 'node-fetch';
const fetch: typeof fetchDefault = (globalThis.fetch ? globalThis.fetch : (fetchDefault as any));
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Strategy } from './bot/types';
import { getErrorMessage, limitHistory, hasWallet, walletKeyboard, loadUsers, saveUsers } from './bot/helpers';
import { filterTokensByStrategy } from './bot/strategy';
import { loadKeypair, getConnection } from './wallet';
import { parseSolanaPrivateKey, toBase64Key } from './keyFormat';
import { unifiedBuy, unifiedSell } from './tradeSources';
import { helpMessages } from './helpMessages';
import { monitorCopiedWallets } from './utils/portfolioCopyMonitor';
// import { priceWS } from './wsListener'; // Removed: not exported from wsListener
import WebSocket from 'ws';
console.log('Loaded TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN);

// Declare users and bot at the top before any usage
let users: Record<string, any> = loadUsers();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
console.log('🚀 Telegram bot script loaded.');

// تعريف دالة sendMainMenu لإظهار القائمة الرئيسية للمستخدم
async function sendMainMenu(ctx: any) {
  const buttons = [
    [{ text: '📊 Show Tokens', callback_data: 'show_tokens' }],
    [{ text: '👛 My Wallet', callback_data: 'my_wallet' }],
    [{ text: '🔑 Restore Wallet', callback_data: 'restore_wallet' }],
    [{ text: '🪙 Create Wallet', callback_data: 'create_wallet' }],
    [{ text: '🍯 Honey Points', callback_data: 'honey_points' }],
    [{ text: '💰 Sell All Wallet', callback_data: 'sell_all_wallet' }],
    [{ text: '📋 Copy Trade', callback_data: 'copy_trade' }],
    [{ text: '🔗 Invite Friends', callback_data: 'invite_friends' }]
  ];
  await ctx.reply('🏠 Main Menu:', {
    reply_markup: { inline_keyboard: buttons }
  });
}

const SENT_TOKENS_DIR = path.join(__dirname, 'sent_tokens');

const MAX_HASHES_PER_USER = 6000; // Max per user (configurable)
const CLEANUP_TRIGGER_COUNT = 3000; // Cleanup starts at this count
const CLEANUP_BATCH_SIZE = 10; // Number of addresses deleted per batch
const SENT_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 1 day only
const SENT_TOKEN_LOCK_MS = 2000; // Simple file lock duration (2 seconds)

// Ensure sent_tokens directory exists at startup
try {
  if (!fs.existsSync(SENT_TOKENS_DIR)) fs.mkdirSync(SENT_TOKENS_DIR);
} catch (e) {
  console.error('❌ Failed to create sent_tokens directory:', e);
}



// Get sent_tokens file name for each user
function getUserSentFile(userId: string): string {
  return path.join(SENT_TOKENS_DIR, `${userId}.json`);
}

// Simple file lock
function lockFile(file: string): Promise<void> {
  const lockPath = file + '.lock';
  return new Promise((resolve) => {
    const tryLock = () => {
      if (!fs.existsSync(lockPath)) {
        fs.writeFileSync(lockPath, String(Date.now()));
        setTimeout(resolve, 10); // Small delay
      } else {
        // If lock is old > 2 seconds, delete it
        try {
          const ts = Number(fs.readFileSync(lockPath, 'utf8'));
          if (Date.now() - ts > SENT_TOKEN_LOCK_MS) fs.unlinkSync(lockPath);
        } catch {}
        setTimeout(tryLock, 20);
      }
    };
    tryLock();
  });
}
function unlockFile(file: string) {
  const lockPath = file + '.lock';
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
}


// Hash a token address (normalized)
export function hashTokenAddress(addr: string): string {
  return crypto.createHash('sha256').update(addr.trim().toLowerCase()).digest('hex');
}



// Read all valid hashes for the user (with smart cleanup)
export async function readSentHashes(userId: string): Promise<Set<string>> {
  const file = getUserSentFile(userId);
  await lockFile(file);
  let hashes: string[] = [];
  const now = Date.now();
  let arr: any[] = [];
  let valid: any[] = [];
  try {
    if (fs.existsSync(file)) {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(arr)) arr = [];
      // Remove expired (older than 1 day)
      valid = arr.filter((obj: any) => obj && obj.hash && (now - (obj.ts || 0) < SENT_TOKEN_EXPIRY_MS));
      hashes = valid.map(obj => obj.hash);
      // If length changed, rewrite with smart error handling
      if (valid.length !== arr.length) {
        let retry = 0;
        while (retry < 3) {
          try {
            fs.writeFileSync(file, JSON.stringify(valid));
            break;
          } catch (e) {
            retry++;
            await new Promise(res => setTimeout(res, 50 * retry));
            if (retry === 3) console.warn(`[sent_tokens] Failed to clean (read) ${file} after retries:`, e);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[sent_tokens] Failed to read/clean ${file}:`, e);
  }
  unlockFile(file);
  return new Set(hashes);
}



// Add a new hash for the user (with deduplication and cleanup)
export async function appendSentHash(userId: string, hash: string) {
  const file = getUserSentFile(userId);
  await lockFile(file);
  const now = Date.now();
  let arr: any[] = [];
  try {
    if (fs.existsSync(file)) {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(arr)) arr = [];
    }
    // Remove expired (older than 1 day)
    arr = arr.filter((obj: any) => obj && obj.hash && (now - (obj.ts || 0) < SENT_TOKEN_EXPIRY_MS));
    // Prevent duplicates
    if (arr.some(obj => obj.hash === hash)) {
      unlockFile(file);
      return;
    }
    arr.push({ hash, ts: now });
    // If reached CLEANUP_TRIGGER_COUNT or more, delete oldest CLEANUP_BATCH_SIZE
    if (arr.length >= CLEANUP_TRIGGER_COUNT) {
      arr = arr.slice(CLEANUP_BATCH_SIZE);
    }
    // If exceeded max, keep only last MAX_HASHES_PER_USER
    if (arr.length > MAX_HASHES_PER_USER) {
      arr = arr.slice(arr.length - MAX_HASHES_PER_USER);
    }
    // Smart error handling on write
    let retry = 0;
    while (retry < 3) {
      try {
        fs.writeFileSync(file, JSON.stringify(arr));
        break;
      } catch (e) {
        retry++;
        await new Promise(res => setTimeout(res, 50 * retry));
        if (retry === 3) console.warn(`[sent_tokens] Failed to write ${file} after retries:`, e);
      }
    }
  } catch (e) {
    console.warn(`[sent_tokens] Failed to write ${file}:`, e);
  }
  unlockFile(file);
}



// No longer need rotateAndCleanIfNeeded with the new system

// Developer command: show all fields used in strategy wizard
bot.command('debug_fields', async (ctx: any) => {
  let msg = '<b>STRATEGY_FIELDS:</b>\n';
  msg += STRATEGY_FIELDS.map(f => `• <b>${f.label}</b> (<code>${f.key}</code>) [${f.type}]`).join('\n');
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// Always reply to /start for any user (new or existing)
bot.start(async (ctx: any) => {
  const user = getOrRegisterUser(ctx);
  await ctx.reply('👋 Welcome! You are now registered. Here is the main menu:', { parse_mode: 'HTML' });
  await sendMainMenu(ctx);
});

// Helper: Register user if new, always returns the user object
function getOrRegisterUser(ctx: any): any {
  const userId = String(ctx.from?.id);
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      username: ctx.from?.username || '',
      firstName: ctx.from?.first_name || '',
      registeredAt: Date.now(),
      trades: 0,
      activeTrades: 1,
      history: [],
      // Add more default fields as needed
    };
    saveUsers(users);
  }
  return users[userId];
}

// Admin command: manually rotate sent_tokens files (delete oldest file)
// For developer use only (e.g. via user ID)
const ADMIN_IDS = [process.env.ADMIN_ID || '123456789']; // Set developer ID here or in env
bot.command('rotate_sent_tokens', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  if (!ADMIN_IDS.includes(userId)) {
    await ctx.reply('❌ This command is for developers only.');
    return;
  }
  const targetId = ctx.message.text.split(' ')[1] || userId;
  const file = getUserSentFile(targetId);
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
      await ctx.reply(`✅ sent_tokens file (${path.basename(file)}) deleted for user ${targetId}.`);
    } catch (e) {
      await ctx.reply(`❌ Failed to delete file: ${e}`);
    }
  } else {
    await ctx.reply('No sent_tokens file to delete.');
  }
});




// === Honey Points Button Handler ===
bot.action('honey_points', async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.reply('🍯 Honey Points system is coming soon!');
});

// === My Wallet Button Handler ===
bot.action('my_wallet', async (ctx: any) => {
  const user = getOrRegisterUser(ctx);
  await ctx.answerCbQuery();
  let replyText = user.wallet
    ? `👛 Your wallet address:\n<code>${user.wallet}</code>`
    : 'You do not have a wallet yet. Use the "Create Wallet" button to generate one.';
  let buttons = [];
  if (user.wallet) {
    buttons.push([{ text: '🔑 Show Private Key', callback_data: 'show_private_key' }]);
  }
  await ctx.reply(replyText, {
    parse_mode: 'HTML',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
  });
});

// Show actual private key (in all available formats)
bot.action('show_private_key', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (!user || !user.secret) {
    return await ctx.reply(helpMessages.wallet_needed, walletKeyboard());
  }
  // Try to show in base64, base58, hex if possible
  let base64 = user.secret;
  let base58 = '';
  let hex = '';
  try {
    const { parseKey } = await import('./wallet');
    const keypair = parseKey(base64);
    const secretKey = Buffer.from(keypair.secretKey);
    base58 = require('bs58').encode(secretKey);
    hex = secretKey.toString('hex');
  } catch {}
  let msg = '⚠️ <b>Your private key:</b>\n';
  msg += `<b>Base64:</b> <code>${base64}</code>\n`;
  if (base58) msg += `<b>Base58:</b> <code>${base58}</code>\n`;
  if (hex) msg += `<b>Hex:</b> <code>${hex}</code>\n`;
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// === Sell All Wallet Button Handler ===
bot.action('sell_all_wallet', async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.reply('💰 Sell All feature is coming soon!');
});

// === Copy Trade Button Handler ===
bot.action('copy_trade', async (ctx: any) => {
  await ctx.answerCbQuery();
  await ctx.reply('📋 Copy Trade feature is coming soon!');
});

// === Invite Friends Button Handler ===
bot.action('invite_friends', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  const inviteLink = getUserInviteLink(userId, ctx);
  await ctx.answerCbQuery();
  await ctx.reply(`🔗 Share this link to invite your friends:\n${inviteLink}`);
});





// Removed duplicate and commented-out helper function definitions. All helper functions are defined once at the top of the file.



// Register strategy handlers and token notifications from wsListener (after users is defined)
import { registerWsNotifications } from './wsListener';

// Register token notification logic (DexScreener or WebSocket)
registerWsNotifications(bot, users);


// Global Token Cache for Sniper Speed

type TokenCacheEntry = { data: any, last: number };
let globalTokenCache: Record<string, TokenCacheEntry> = {};
let lastGlobalCacheUpdate = 0;
const CACHE_TTL = 60 * 1000; // 1 minute

function getStrategyCacheKey(strategy: any): string {
  // استخدم JSON.stringify ثم sha256 للحصول على مفتاح فريد للاستراتيجية
  const str = JSON.stringify(strategy || {});
  return crypto.createHash('sha256').update(str).digest('hex');
}

function getUserInviteLink(userId: string, ctx?: any): string {
  // Use env BOT_USERNAME or fallback to ctx.botInfo.username
  const botUsername = process.env.BOT_USERNAME || ctx?.botInfo?.username || 'YourBotUsername';
  return `https://t.me/${botUsername}?start=${userId}`;
}

// Log every incoming update for tracing
bot.use((ctx: any, next: any) => {
  let text = undefined;
  let data = undefined;
  if ('message' in ctx && ctx.message && typeof ctx.message === 'object' && 'text' in ctx.message) {
    text = (ctx.message as any).text;
  }
  if ('callbackQuery' in ctx && ctx.callbackQuery && typeof ctx.callbackQuery === 'object' && 'data' in ctx.callbackQuery) {
    data = (ctx.callbackQuery as any).data;
  }
  console.log('📥 Incoming update:', {
    type: ctx.updateType,
    from: ctx.from?.id,
    text,
    data
  });
  return next();
});

// Welcome sticker
const WELCOME_STICKER = 'CAACAgUAAxkBAAEBQY1kZ...'; // Welcome sticker ID

// Users file
const USERS_FILE = 'users.json';

let boughtTokens: Record<string, Set<string>> = {};
// Cleanup boughtTokens for users who have not bought tokens in the last 24h
function cleanupBoughtTokens() {
  const now = Date.now();
  for (const userId in boughtTokens) {
    const user = users[userId];
    if (!user || !user.history) {
      delete boughtTokens[userId];
      continue;
    }
    // Remove tokens older than 24h from the set (if you store timestamps in history)
    // For now, just keep the set as is, but you can enhance this logic if you store timestamps
    // Optionally, clear the set if user has no active strategy
    if (!user.strategy || !user.strategy.enabled) {
      boughtTokens[userId].clear();
    }
  }
}
setInterval(cleanupBoughtTokens, 60 * 60 * 1000); // Clean every hour



// --- DexScreener API: fetch all pairs for a token address ---
async function fetchDexScreenerPairs(tokenAddress: string): Promise<any[]> {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`);
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (Array.isArray(data)) return data;
    if (typeof data === 'object' && data !== null && 'pairs' in data && Array.isArray((data as any).pairs)) return (data as any).pairs;
    return [];
  } catch (e) {
    console.error('DexScreener API error:', e);
    return [];
  }
}

// --- Unified token fetch: DexScreener (main), Jupiter (secondary) ---
async function fetchUnifiedTokenList(): Promise<any[]> {
  let allTokens: any[] = [];
  // DexScreener: fetch trending tokens (or from a list, or from user strategies)
  // For demo, fetch a few known tokens (SOL, USDC, etc.)
  const trending = [
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    // ...add more trending or user-watched tokens here
  ];
  for (const addr of trending) {
    const pairs = await fetchDexScreenerPairs(addr);
    allTokens = allTokens.concat(pairs.map((p: any) => ({
      name: p.baseToken?.name,
      symbol: p.baseToken?.symbol,
      address: p.baseToken?.address,
      priceUsd: p.priceUsd,
      priceNative: p.priceNative,
      marketCap: p.marketCap,
      volume: p.volume?.h24,
      holders: undefined, // DexScreener does not provide holders
      age: p.pairCreatedAt,
      verified: undefined,
      url: p.url,
      pairAddress: p.pairAddress,
      dexId: p.dexId,
      quoteToken: p.quoteToken,
      txns: p.txns,
      liquidity: p.liquidity
    })));
  }
  // Jupiter (optional, as secondary)
  try {
    const jupRes = await fetch('https://quote-api.jup.ag/v6/tokens');
    if (jupRes.ok) {
      const jupData: unknown = await jupRes.json();
      if (typeof jupData === 'object' && jupData !== null && 'tokens' in jupData && Array.isArray((jupData as any).tokens)) {
        allTokens = allTokens.concat((jupData as any).tokens.map((t: any) => ({
          name: t.name,
          symbol: t.symbol,
          address: t.address,
          priceUsd: t.price,
          imageUrl: t.logoURI,
          verified: t.tags?.includes('verified'),
          description: t.extensions?.description,
          links: [
            ...(t.extensions?.website ? [{ label: 'Website', url: t.extensions.website, type: 'website' }] : []),
            ...(t.extensions?.twitter ? [{ label: 'Twitter', url: t.extensions.twitter, type: 'twitter' }] : []),
            ...(t.extensions?.discord ? [{ label: 'Discord', url: t.extensions.discord, type: 'discord' }] : []),
          ],
        })));
      }
    }
  } catch (e) {
    console.error('Jupiter fetch error:', e);
  }
  // Deduplicate by address
  const seen = new Set();
  const deduped = allTokens.filter(t => {
    const addr = t.address || t.tokenAddress || t.pairAddress;
    if (!addr || seen.has(addr)) return false;
    seen.add(addr);
    return true;
  });
  return deduped;
}

// Define addHoneyToken at top level
function addHoneyToken(userId: string, tokenData: any, users: any) {
  // ...existing logic for adding honey token...
  // Placeholder implementation
  if (!users[userId].honeyTokens) users[userId].honeyTokens = [];
  users[userId].honeyTokens.push(tokenData);
}

// Define getCachedTokenList at top level

// تحسين: جلب وتحديث الكاش لكل عنوان عملة
async function getCachedTokenList(forceUpdate = false): Promise<any[]> {
  const now = Date.now();
  // تحديث الكاش العام إذا انتهت صلاحيته أو طلب تحديث
  if (forceUpdate || now - lastGlobalCacheUpdate > CACHE_TTL) {
    const tokens = await fetchUnifiedTokenList();
    // تحديث الكاش لكل عنوان
    globalTokenCache = {};
    for (const t of tokens) {
      const addr = t.address || t.tokenAddress || t.pairAddress;
      if (!addr) continue;
      globalTokenCache[addr] = { data: t, last: now };
    }
    lastGlobalCacheUpdate = now;
    return tokens;
  }
  // إرجاع جميع العملات من الكاش
  return Object.values(globalTokenCache).map(e => e.data);
}



// Restore Wallet button handler is now registered in wsListener


// === Restore Wallet Button Handler ===
const restoreWalletSessions: Record<string, boolean> = {};
bot.action('restore_wallet', async (ctx: any) => {
  const userId = String(ctx.from?.id);
  restoreWalletSessions[userId] = true;
  await ctx.answerCbQuery();
  await ctx.reply(
    '🔑 Please send your private key, mnemonic, or JSON array to restore your wallet.\n\n' +
    'Supported formats: base64, base58, hex, or 12/24-word mnemonic.\n' +
    '<b>Warning:</b> Never share your private key with anyone you do not trust!',
    { parse_mode: 'HTML' }
  );
});

// Handler for processing wallet restoration input
bot.on('text', async (ctx: any, next: any) => {
  const userId = String(ctx.from?.id);
  if (!restoreWalletSessions[userId]) return next();
  const input = ctx.message.text.trim();
  const { parseKey } = await import('./wallet');
  try {
    const keypair = parseKey(input);
    users[userId].wallet = keypair.publicKey.toBase58();
    users[userId].secret = Buffer.from(keypair.secretKey).toString('base64');
    users[userId].history = users[userId].history || [];
    users[userId].history.push('Restored wallet');
    saveUsers(users);
    delete restoreWalletSessions[userId];
    await ctx.reply('✅ Wallet restored successfully! Your address: ' + users[userId].wallet);
    await sendMainMenu(ctx);
  } catch (e: any) {
    await ctx.reply('❌ Failed to restore wallet. Please provide a valid key (mnemonic, base58, base64, or hex) or type /cancel.');
  }
});

// Create Wallet button handler
bot.action('create_wallet', async (ctx: any) => {
  const user = getOrRegisterUser(ctx);
  // Try to create wallet from any key in
  try {
    const { Keypair } = await import('@solana/web3.js');
    const keypair = Keypair.generate();
    user.wallet = keypair.publicKey.toBase58();
    user.secret = Buffer.from(keypair.secretKey).toString('base64');
    user.history = user.history || [];
    user.history.push('Created wallet');
    saveUsers(users);
    await ctx.reply('✅ Wallet created successfully! Your address: ' + user.wallet);
    await sendMainMenu(ctx);
  } catch (e: any) {
    await ctx.reply('❌ Failed to create wallet. Please try again later.');
  }
});
