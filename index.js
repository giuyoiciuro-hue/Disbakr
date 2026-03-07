import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 5000;

// توكن البوت
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// 3 RPCs فقط كما طلبت
const ALCHEMY_URLS = [
  process.env.RPC_URL,
  process.env.RPC_URL2,
  process.env.RPC_URL3
];

let activeUrls = [];

// التحقق من صحة RPCs
async function validateUrls() {
  console.log("🔄 جاري التحقق من صحة RPCs...");
  const uniqueUrls = [...new Set(ALCHEMY_URLS)]; // إزالة التكرار من القائمة الأساسية
  const checks = uniqueUrls.map(async (url) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        timeout: 5000
      });
      const data = await response.json();
      if (response.ok && data.result === "ok") {
        console.log(`✅ RPC صالح`);
        return url;
      }
      return null;
    } catch (e) {
      console.log(`❌ RPC غير صالح`);
      return null;
    }
  });

  activeUrls = (await Promise.all(checks)).filter(u => u !== null);

  if (activeUrls.length === 0) {
    activeUrls = [ALCHEMY_URLS[0]];
  }

  // محاكاة تعدد الروابط إذا كان الرابط نفسه مكرراً لضمان التوازي البرمجي
  if (activeUrls.length === 1 && ALCHEMY_URLS.length > 1) {
     activeUrls = [activeUrls[0], activeUrls[0], activeUrls[0]];
  }

  console.log(`✅ ${activeUrls.length} قنوات RPC نشطة`);
}

function getConnection(index = 0) {
  // استخدام الرابط المقابل للاندكس لضمان التوازي الحقيقي
  const url = activeUrls[index % activeUrls.length];
  return new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true });
}

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_CASHBACK_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// معالجة خطأ التكرار لإيقاف النسخ القديمة
bot.on('polling_error', (error) => {
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.log("⚠️ تم اكتشاف نسخة أخرى تعمل، جاري محاولة التوقف...");
    process.exit(1); // الخروج للسماح لـ Replit بإعادة التشغيل النظيف
  }
});

const userRequests = new Map();

// دالة لحساب PDA المكافآت العادية
function getCreatorVaultPDA(creator) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

// دالة لحساب PDA الكاش باك الجديد
function getPumpCashbackPDA(userWallet) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), userWallet.toBuffer()],
    PUMP_CASHBACK_PROGRAM_ID
  );
  return pda;
}

// دالة محسنة للحصول على الرصيد
async function getAccountBalance(conn, pubkey) {
  try {
    const info = await conn.getAccountInfo(pubkey);
    if (!info) return 0;
    return info.lamports / 1e9;
  } catch (e) {
    return 0;
  }
}

// دالة للحصول على رصيد WSOL لمحفظة معينة
async function getWSOLBalance(conn, owner) {
  try {
    const response = await conn.getTokenAccountsByOwner(owner, {
      mint: WSOL_MINT,
    });
    
    if (response.value.length === 0) return 0;
    
    let totalBalance = 0;
    for (const account of response.value) {
      const balance = await conn.getTokenAccountBalance(account.pubkey);
      totalBalance += parseFloat(balance.value.uiAmount || 0);
    }
    return totalBalance;
  } catch (e) {
    return 0;
  }
}

// دالة متقدمة لاستخراج المحافظ من أي نص أو ملف
function extractWalletsFromText(text) {
  // إذا كان النص طويلاً جداً، فهذا يعني أنه ملف
  if (text.length > 4000) {
    console.log("📄 تم استلام ملف كبير، جاري معالجته...");
  }

  const lines = text.split('\n');
  const wallets = new Map();

  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;

    // Base58 private key
    try {
      const decoded = bs58.decode(trimmedLine);
      if (decoded.length === 64) {
        const keypair = Keypair.fromSecretKey(decoded);
        const address = keypair.publicKey.toBase58();
        if (!wallets.has(address)) {
          wallets.set(address, {
            address: address,
            privateKey: trimmedLine,
            type: 'privateKey'
          });
        }
        return;
      }
    } catch (e) {}

    // Array format [123,45,67,...]
    if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
      try {
        const numbers = JSON.parse(trimmedLine);
        if (Array.isArray(numbers) && numbers.length === 64) {
          const secretKey = Uint8Array.from(numbers);
          const keypair = Keypair.fromSecretKey(secretKey);
          const address = keypair.publicKey.toBase58();
          if (!wallets.has(address)) {
            wallets.set(address, {
              address: address,
              privateKey: trimmedLine,
              type: 'privateKey'
            });
          }
          return;
        }
      } catch (e) {}
    }

    // Solana address
    const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const addresses = trimmedLine.match(solanaAddressRegex);

    if (addresses) {
      addresses.forEach(address => {
        try {
          new PublicKey(address);
          if (!wallets.has(address)) {
            wallets.set(address, {
              address: address,
              privateKey: null,
              type: 'address'
            });
          }
        } catch (e) {}
      });
    }
  });

  return Array.from(wallets.values());
}

// فحص محفظة واحدة
async function checkWallet(walletData, rpcIndex = 0) {
  const { address, privateKey, type } = walletData;

  try {
    const creatorWallet = new PublicKey(address);
    const pumpPDA = getCreatorVaultPDA(creatorWallet);
    const cashbackPDA = getPumpCashbackPDA(creatorWallet);

    // استخدام RPC محدد بناءً على ترتيب المحفظة في الدفعة
    const connection = getConnection(rpcIndex);
    
    // إضافة timeout للطلب لتجنب التعليق وتقليل وقت الانتظار
    const [pumpBalance, cashbackBalance] = await Promise.all([
      Promise.race([
        getAccountBalance(connection, pumpPDA),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]),
      Promise.race([
        getWSOLBalance(connection, cashbackPDA),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ])
    ]);

    return {
      address: address,
      privateKey: privateKey,
      hasPrivateKey: type === 'privateKey',
      pumpPDA: pumpPDA.toBase58(),
      cashbackPDA: cashbackPDA.toBase58(),
      pumpBalance: pumpBalance,
      cashbackBalance: cashbackBalance,
      success: true,
      error: null
    };
  } catch (error) {
    return {
      address: address,
      privateKey: privateKey,
      hasPrivateKey: type === 'privateKey',
      pumpPDA: 'غير متاح',
      cashbackPDA: 'غير متاح',
      pumpBalance: 0,
      cashbackBalance: 0,
      success: false,
      error: error.message
    };
  }
}

// فحص متوازي للمحافظ - كل 3 محافظ معاً
async function checkWalletsParallel(wallets, onProgress) {
  const results = [];
  const batchSize = 3; // نرسل 3 طلبات معاً لأن عندنا 3 RPCs

  for (let i = 0; i < wallets.length; i += batchSize) {
    const batch = wallets.slice(i, i + batchSize);
    const batchPromises = batch.map((wallet, index) => checkWallet(wallet, index));

    // تنفيذ 3 محافظ بالتوازي
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // تحديث التقدم
    if (onProgress) {
      onProgress(Math.min(i + batchSize, wallets.length), wallets.length);
    }

    // تأخير قليل بين الدفعات
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return results;
}

// إنشاء ملف النتائج
function createResultsFile(results) {
  const sortedResults = [...results].sort((a, b) => (b.pumpBalance + b.cashbackBalance) - (a.pumpBalance + a.cashbackBalance));
  const resultsWithBalance = sortedResults.filter(r => r.success && (r.pumpBalance > 0 || r.cashbackBalance > 0));

  let content = '';
  let totalPump = 0;
  let totalCashback = 0;

  resultsWithBalance.forEach((result, index) => {
    totalPump += result.pumpBalance;
    totalCashback += result.cashbackBalance;

    content += `═══════════════════════════════════════════\n`;
    content += `المحفظة #${index + 1}\n`;
    content += `═══════════════════════════════════════════\n`;
    content += `📍 العنوان: ${result.address}\n`;

    if (result.hasPrivateKey) {
      content += `🔑 المفتاح الخاص: ${result.privateKey}\n`;
    }

    content += `🏦 PDA المكافآت: ${result.pumpPDA}\n`;
    content += `💰 رصيد المكافآت: ${result.pumpBalance.toFixed(6)} SOL\n`;
    content += `💸 رصيد الكاش باك: ${result.cashbackBalance.toFixed(6)} SOL\n`;
    content += `🔗 Solscan: https://solscan.io/account/${result.address}\n`;
    content += `═══════════════════════════════════════════\n\n`;
  });

  // إحصائيات
  content += `\n═══════════════════════════════════════════\n`;
  content += `📊 إحصائيات عامة\n`;
  content += `═══════════════════════════════════════════\n`;
  content += `✅ المحافظ التي بها رصيد: ${resultsWithBalance.length}\n`;
  content += `💰 إجمالي المكافآت: ${totalPump.toFixed(6)} SOL\n`;
  content += `💸 إجمالي الكاش باك: ${totalCashback.toFixed(6)} SOL\n`;
  content += `🔥 الإجمالي الكلي: ${(totalPump + totalCashback).toFixed(6)} SOL\n`;
  content += `⏰ وقت الفحص: ${new Date().toLocaleString('ar-EG')}\n`;

  return content;
}

// دالة لتنسيق النتيجة كرسالة نصية قصيرة
function formatResultsAsMessage(results) {
  const sortedResults = [...results].sort((a, b) => (b.pumpBalance + b.cashbackBalance) - (a.pumpBalance + a.cashbackBalance));
  const resultsWithBalance = sortedResults.filter(r => r.success && (r.pumpBalance > 0 || r.cashbackBalance > 0));
  
  if (resultsWithBalance.length === 0) return "❌ لم يتم العثور على أي رصيد.";

  let message = `📊 *نتائج الفحص (${resultsWithBalance.length} محفظة)*\n\n`;
  let total = 0;

  resultsWithBalance.slice(0, 15).forEach((r, i) => {
    const sum = r.pumpBalance + r.cashbackBalance;
    total += sum;
    message += `*${i+1}.* \`${r.address.substring(0,6)}...${r.address.substring(r.address.length-4)}\`\n`;
    message += `💰 Pump: \`${r.pumpBalance.toFixed(4)}\` | 💸 Cash: \`${r.cashbackBalance.toFixed(4)}\`\n\n`;
  });

  if (resultsWithBalance.length > 15) {
    message += `... و ${resultsWithBalance.length - 15} محافظ أخرى (موجودة في الملف المرفق)\n\n`;
  }

  const grandTotal = resultsWithBalance.reduce((s, r) => s + r.pumpBalance + r.cashbackBalance, 0);
  message += `*🔥 الإجمالي الكلي: ${grandTotal.toFixed(6)} SOL*`;
  
  return message;
}

  // معالجة رسائل التلغرام
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // التحقق إذا كان هناك ملف مرفق
  if (msg.document) {
    try {
      const fileId = msg.document.file_id;
      const fileLink = await bot.getFileLink(fileId);
      const response = await fetch(fileLink);
      const fileContent = await response.text();

      if (!fileContent || fileContent.trim().length === 0) {
        return bot.sendMessage(chatId, "❌ الملف فارغ");
      }

      // معالجة محتوى الملف وتعيينه كـ text لمعالجته لاحقاً
      msg.text = fileContent;
      console.log(`📄 تم استلام ملف بحجم ${fileContent.length} حرف`);
    } catch (error) {
      console.error("Error reading file:", error);
      return bot.sendMessage(chatId, "❌ فشل في قراءة الملف. تأكد أنه ملف نصي صالح.");
    }
  }

  const text = msg.text;
  if (!text) return;

  if (msg.text === '/start' || msg.text === '/help') {
    // إنهاء أي عمليات جارية للمستخدم عند طلب البدء من جديد
    if (userRequests.has(chatId)) {
      userRequests.delete(chatId);
      bot.sendMessage(chatId, "🔄 تم إعادة ضبط الجلسة وإيقاف العمليات السابقة.");
    }

    return bot.sendMessage(chatId, 
      `🎯 *بوت فحص مكافآت Pump.fun*\n\n` +
      `*المميزات:*\n` +
      `• فحص متوازي: 3 محافظ في نفس الوقت\n` +
      `• دعم الملفات النصية (.txt)\n` +
      `• دعم جميع تنسيقات المفاتيح\n` +
      `• منع التكرار تلقائياً\n` +
      `• ترتيب النتائج من الأعلى للأقل\n\n` +
      `*الاستخدام:*\n` +
      `• أرسل نصاً به عناوين أو مفاتيح\n` +
      `• أرسل ملف .txt يحتوي على القائمة\n` +
      `• حتى 100 محفظة في المرة الواحدة`,
      { parse_mode: 'Markdown' }
    );
  }

  if (msg.text === '/cancel') {
    userRequests.delete(chatId);
    return bot.sendMessage(chatId, "✅ تم الإلغاء");
  }

  if (userRequests.has(chatId)) {
    return bot.sendMessage(chatId, "⏳ يوجد فحص جاري");
  }

  userRequests.set(chatId, true);

  let statusMessage = null;

  try {
    const extractedWallets = extractWalletsFromText(msg.text);
    const sourceType = msg.document ? 'ملف' : 'نص';

    if (extractedWallets.length === 0) {
      userRequests.delete(chatId);
      return bot.sendMessage(chatId, `❌ لم يتم العثور على محافظ صالحة في ال${sourceType}`);
    }

    if (extractedWallets.length > 2000) {
      userRequests.delete(chatId);
      return bot.sendMessage(chatId, "❌ الحد الأقصى 100 محفظة");
    }

    statusMessage = await bot.sendMessage(
      chatId, 
      `📄 تم استخراج ${extractedWallets.length} محفظة من ال${sourceType}\n` +
      `🔄 جاري الفحص المتوازي (3 محافظ في نفس الوقت)...`
    );

    const results = [];
    let processed = 0;

    // فحص متوازي للمحافظ
    for (let i = 0; i < extractedWallets.length; i += activeUrls.length) {
      const batch = extractedWallets.slice(i, i + activeUrls.length);
      // تمرير الاندكس لضمان استخدام RPC مختلف لكل محفظة في الدفعة
      const batchPromises = batch.map((wallet, index) => checkWallet(wallet, index));

      // تنفيذ المحافظ بالتوازي
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      processed += batch.length;

      // تحديث كل دفعة
      await bot.editMessageText(
        `📊 تم فحص ${processed} من ${extractedWallets.length} محفظة...\n` +
        `⚡ سرعة: 3 محافظ لكل دفعة`,
        {
          chat_id: chatId,
          message_id: statusMessage.message_id
        }
      );

      // تأخير قليل جداً
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    await bot.deleteMessage(chatId, statusMessage.message_id);

    const resultsWithBalance = results.filter(r => r.success && (r.pumpBalance > 0 || r.cashbackBalance > 0));

    if (resultsWithBalance.length === 0) {
      await bot.sendMessage(chatId, "❌ لم يتم العثور على أي رصيد في جميع المحافظ");
      return;
    }

    const message = formatResultsAsMessage(results);
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    // إذا كانت النتائج كثيرة، نرسل ملفاً أيضاً
    if (resultsWithBalance.length > 5) {
      const fileContent = createResultsFile(results);
      const fileName = `pump_combined_results_${Date.now()}.txt`;
      const filePath = path.join('/tmp', fileName);
      fs.writeFileSync(filePath, fileContent, 'utf8');

      await bot.sendDocument(chatId, filePath, {
        caption: `📊 النتائج الكاملة لـ ${results.length} محفظة\n` +
                 `🔥 الإجمالي الكلي: ${resultsWithBalance.reduce((sum, r) => sum + r.pumpBalance + r.cashbackBalance, 0).toFixed(6)} SOL`
      });

      fs.unlinkSync(filePath);
    }

  } catch (error) {
    if (statusMessage) {
      try { await bot.deleteMessage(chatId, statusMessage.message_id); } catch (e) {}
    }
    await bot.sendMessage(chatId, `❌ خطأ: ${error.message}`);
  } finally {
    userRequests.delete(chatId);
  }
});

// صفحة ويب
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>بوت فحص Pump.fun</title>
        <style>
            body { font-family: Arial; background: #1a1a1a; color: #fff; text-align: center; padding: 50px; }
            .container { max-width: 600px; margin: 0 auto; background: #2d2d2d; padding: 30px; border-radius: 10px; }
            h1 { color: #00ff9d; }
            .status { color: #00ff9d; font-size: 20px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎯 بوت فحص Pump.fun</h1>
            <div class="status">✅ البوت يعمل - ${activeUrls.length} RPC نشطة</div>
            <p>⚡ فحص متوازي: 3 محافظ في نفس الوقت</p>
            <p>📁 دعم الملفات النصية</p>
        </div>
    </body>
    </html>
  `);
});

// بدء التشغيل
app.listen(PORT, "0.0.0.0", async () => {
  await validateUrls();
  console.log(`🚀 السيرفر على port ${PORT}`);
  console.log(`🤖 بوت التلغرام يعمل...`);
});