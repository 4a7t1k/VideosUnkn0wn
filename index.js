/*
 * ERROR FIX: The 'ETELEGRAM: 401 Unauthorized' error means your Telegram Bot Token is invalid.
 * SOLUTION:
 * 1. Go to the @BotFather bot on Telegram.
 * 2. Use the /mybots command, select your bot, and go to 'API Token'.
 * 3. Revoke the old token and copy the new one.
 * 4. Paste the new token into the TELEGRAM_BOT_TOKEN constant below.
*/

const TelegramBot = require('node-telegram-bot-api');
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const mongoose = require('mongoose');

// --- ⚠️ CONFIGURATION ---
// PASTE YOUR NEW, VALID TOKEN FROM @BotFather HERE
const TELEGRAM_BOT_TOKEN = "7776486569:AAGbFJ9oZ184GAu9H6nY28SINUxfGW9JKuA";
const VEO_API_KEY = "sk-paxsenix-_i4gxqZtBsLskDInu2RZXHmHuQJpjKSemVBzJsc47X_Hu23w";
const IMGBB_API_KEY = "1b4d99fa0c3195efe42ceb62670f2a25";
const MONGO_URI = 'mongodb+srv://aminulzisan76:aminulzisan@cluster0.cxo0nw4.mongodb.net/veobot';
const OWNER_ID = 8160965620; // Your Telegram User ID for admin commands
const OWNER_USERNAME = "@Unkn0wn471K";
const FREE_TIER_LIMIT = 1;

// --- Multi-Message Prompt Handling ---
const PROMPT_BUFFER_TIMEOUT = 2000; // 2 seconds
const promptBuffer = new Map(); // Stores { userId: { prompt: string, timeoutId: Timeout, replyToMessage: object } }

// --- API and Model Constants ---
const VEO_API_URL = "https://api.paxsenix.org/ai-video/veo-3";
const VALID_RATIOS = ["16:9", "9:16"];
const VALID_MODELS = ["veo-3"];

// --- Bot Initialization ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
console.log("🤖 Veo AI Telegram Bot is starting...");

bot.on('polling_error', (error) => {
    console.error(`[polling_error] {"code":"${error.code}","message":"${error.message}"}`);
    if (error.code === 'ETELEGRAM' && error.message.includes('401 Unauthorized')) {
        console.error("--- !!! CRITICAL: INVALID BOT TOKEN !!! ---");
        console.error("The Telegram API token is incorrect or has been revoked. Please get a new one from @BotFather and update your script.");
    }
});


// --- Temporary Directory Setup ---
const TEMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// --- 🌿 DATABASE SETUP ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("🍃 MongoDB connected successfully."))
    .catch(err => {
        console.error("❌ MongoDB connection error:", err);
        process.exit(1);
    });

const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    isApproved: { type: Boolean, default: false },
    requestsMade: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);
// --- END OF DATABASE SETUP ---

// --- Localization (Language Strings) ---
const langs = {
    en: {
        startMessage: "👋 Welcome to the Veo AI Bot!\n\nYou have **1 free video generation** to try out the bot. Use the /veo command to start creating!",
        startMessageReturningTrial: "👋 Welcome back!\n\nYou still have your free video trial. Use /veo to create your video.",
        startMessageApproved: "👋 Welcome back! Your account is approved for **unlimited** video generations.",
        startMessageOwner: "👋 Welcome, Owner! You have unlimited access. Use /veo to begin.",
        limitReached: "⚠️ You have used your free trial.\n\nPlease wait for the owner (%1) to approve your account for unlimited access. The owner has been notified.",
        ownerNotified: "👤 New user started the bot:\n\nName: %1 (@%2)\nID: `%3`\n\nThey have 1 free trial. Use `/approve %3` to give them unlimited access.",
        userNotFound: "❌ User with ID %1 not found.",
        userAlreadyApproved: "✅ User %1 is already approved.",
        userApproved: "✅ User %1 (`%2`) has been approved for unlimited access!",
        userListHeader: "--- User List ---\n\n",
        userListEntry: "👤 Name: %1\n🆔 ID: `%2`\n✅ Approved: %3\n▶️ Requests: %4\n\n",
        noUsers: "No users found in the database yet.",
        notOwner: "❌ This command can only be used by the owner.",
        noPrompt: "Please provide a text prompt or reply to an image with the command.\nExample: `/veo a beautiful sunset`",
        sending: "⏳ Sending request... Please wait. This can take up to 5 minutes.",
        apiFailed: "❌ The API failed to return job information. Please try again later.",
        requestSent: "✅ Request sent successfully!\n\nJob ID: %1\n\nNow polling for results...",
        noResults: "❌ No results were returned within the time limit.",
        noVideo: "❌ No video file was found in the API response.",
        downloadFailed: "❌ Failed to download or send the generated video.",
        error: "❌ An unexpected error occurred. Please try again later.",
        videoCaption: "✅ Video sent as a document for maximum quality."
    }
};

const getLang = (key, ...args) => {
    let text = langs.en[key] || "Language string not found.";
    args.forEach((arg, index) => {
        text = text.replace(`%${index + 1}`, arg);
    });
    return text;
};

// --- Helper Functions ---
async function downloadFile(url, dest) {
    const writer = fs.createWriteStream(dest);
    const response = await axios.get(url, { responseType: "stream" });
    return new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
    });
}
async function uploadToImgbb(filePath) {
    try {
        const form = new FormData();
        form.append("image", fs.createReadStream(filePath));
        const res = await axios.post("https://api.imgbb.com/1/upload", form, {
            headers: form.getHeaders(),
            params: { key: IMGBB_API_KEY }
        });
        return res.data?.data?.url || null;
    } catch (error) {
        console.error("ImgBB Upload Error:", error.response ? error.response.data : error.message);
        return null;
    }
}
function extractMp4Urls(obj) {
    let urls = [];
    function search(value) {
        if (!value) return;
        if (typeof value === "string" && value.toLowerCase().endsWith(".mp4")) {
            urls.push(value);
        } else if (Array.isArray(value)) {
            value.forEach(search);
        } else if (typeof value === 'object') {
            for (const k in value) search(value[k]);
        }
    }
    search(obj);
    return [...new Set(urls)];
}

// --- Main Video Request Processor ---
async function processVeoRequest(chatId, fullPrompt, replyToMessage) {
    let waitingMsg;
    let user;

    try {
        if (chatId !== OWNER_ID) {
            user = await User.findOne({ userId: chatId });
            if (!user) {
                console.error(`User with ID ${chatId} used /veo but not in DB.`);
                return bot.sendMessage(chatId, getLang("error"));
            }
            if (!user.isApproved && user.requestsMade >= FREE_TIER_LIMIT) {
                return bot.sendMessage(chatId, getLang("limitReached", OWNER_USERNAME));
            }
        } else {
             console.log(`Owner (${OWNER_ID}) is using the bot. Bypassing usage checks.`);
        }
        
        let prompt, ratio, model;
        const args = fullPrompt.split(/\s+/).filter(Boolean);
        const ratioIndex = args.findIndex(a => a.toLowerCase() === "--ar");
        if (ratioIndex !== -1) {
            ratio = args[ratioIndex + 1];
            args.splice(ratioIndex, 2);
        } else { ratio = "9:16"; }
        const potentialModel = args[args.length - 1];
        if (VALID_MODELS.includes(potentialModel)) {
            model = potentialModel;
            args.pop();
        } else { model = "veo-3"; }
        prompt = args.join(" ").trim();
        let imageUrls = [];
        if (replyToMessage && replyToMessage.photo) {
            if (!prompt) return bot.sendMessage(chatId, getLang("noPromptWithImage"));
            const photo = replyToMessage.photo[replyToMessage.photo.length - 1];
            const fileLink = await bot.getFileLink(photo.file_id);
            const filePath = path.join(TEMP_DIR, `tg_img_${Date.now()}.jpg`);
            try {
                await downloadFile(fileLink, filePath);
                const uploadedUrl = await uploadToImgbb(filePath);
                if (!uploadedUrl) return bot.sendMessage(chatId, getLang("uploadFailed"));
                imageUrls.push(uploadedUrl);
            } catch (err) {
                console.error(err);
                return bot.sendMessage(chatId, getLang("processFailed"));
            } finally {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        } else if (!prompt) {
            return bot.sendMessage(chatId, getLang("noPrompt"));
        }
        const type = imageUrls.length ? "image-to-video" : "text-to-video";
        waitingMsg = await bot.sendMessage(chatId, getLang("sending"), { reply_to_message_id: replyToMessage?.message_id });
        const params = { prompt, ratio, model, type };
        if (imageUrls.length) params.imageUrls = imageUrls.join(",");
        const res = await axios.get(VEO_API_URL, { headers: { Authorization: `Bearer ${VEO_API_KEY}` }, params });
        const jobId = res.data?.jobId || res.data?.job_id;
        const taskUrl = res.data?.task_url || res.data?.taskUrl || res.data?.task;
        if (!jobId || !taskUrl) return bot.editMessageText(getLang("apiFailed"), { chat_id: chatId, message_id: waitingMsg.message_id });
        await bot.editMessageText(getLang("requestSent", jobId), { chat_id: chatId, message_id: waitingMsg.message_id });
        let taskData = null;
        const maxWaitSeconds = 600, checkIntervalSeconds = 5;
        for (let i = 0; i < maxWaitSeconds / checkIntervalSeconds; i++) {
            await new Promise(r => setTimeout(r, checkIntervalSeconds * 1000));
            try {
                const tRes = await axios.get(taskUrl, { headers: { Authorization: `Bearer ${VEO_API_KEY}` } });
                if (tRes.data && (tRes.data.status === "done" || tRes.data.status === "success" || tRes.data.url || tRes.data.data)) {
                    taskData = tRes.data;
                    break;
                }
            } catch (pollError) { console.error("Polling error, continuing...", pollError.message); }
        }
        if (!taskData) return bot.editMessageText(getLang("noResults"), { chat_id: chatId, message_id: waitingMsg.message_id });
        await bot.deleteMessage(chatId, waitingMsg.message_id);
        const mp4Urls = extractMp4Urls(taskData);
        if (taskData.url?.toLowerCase().endsWith(".mp4")) mp4Urls.push(taskData.url);
        if (!mp4Urls.length) return bot.sendMessage(chatId, getLang("noVideo"), { reply_to_message_id: replyToMessage?.message_id });
        let videosSent = 0;
        for (const videoUrl of [...new Set(mp4Urls)]) {
            const videoPath = path.join(TEMP_DIR, `veo_result_${Date.now()}.mp4`);
            try {
                await downloadFile(videoUrl, videoPath);
                await bot.sendDocument(chatId, videoPath, { caption: getLang("videoCaption") });
                videosSent++;
            } catch (err) {
                console.error("Download/Send Video Error:", err);
                await bot.sendMessage(chatId, getLang("downloadFailed"));
            } finally {
                if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            }
        }
        
        if (videosSent > 0 && chatId !== OWNER_ID && user) {
            user.requestsMade += 1;
            await user.save();
        }

    } catch (error) {
        console.error("Main Process Error:", error.response ? error.response.data : error.message);
        if (waitingMsg) await bot.editMessageText(getLang("error"), { chat_id: chatId, message_id: waitingMsg.message_id });
        else await bot.sendMessage(chatId, getLang("error"));
    }
}


// --- Bot Command Handlers ---
bot.onText(/^\/start$/, async (msg) => {
    try {
        const { id: userId, username, first_name: firstName } = msg.from;

        if (userId === OWNER_ID) {
            return bot.sendMessage(userId, getLang("startMessageOwner"));
        }

        let user = await User.findOne({ userId });

        if (!user) {
            user = new User({
                userId,
                username: username || 'N/A',
                firstName: firstName || 'User',
                isApproved: false,
                requestsMade: 0
            });
            await user.save();
            bot.sendMessage(OWNER_ID, getLang("ownerNotified", user.firstName, user.username, userId), { parse_mode: 'Markdown' });
            return bot.sendMessage(userId, getLang("startMessage"), { parse_mode: 'Markdown' });
        } else {
            if (user.isApproved) {
                return bot.sendMessage(userId, getLang("startMessageApproved"), { parse_mode: 'Markdown' });
            } else if (user.requestsMade < FREE_TIER_LIMIT) {
                return bot.sendMessage(userId, getLang("startMessageReturningTrial"));
            } else {
                return bot.sendMessage(userId, getLang("limitReached", OWNER_USERNAME));
            }
        }
    } catch (error) {
        console.error("!!! CRITICAL ERROR in /start handler:", error);
        if (msg && msg.chat && msg.chat.id) {
            bot.sendMessage(msg.chat.id, getLang("error"));
        }
    }
});

// --- General Message & /veo Handlers ---
const finalizeAndProcessPrompt = (userId) => {
    if (promptBuffer.has(userId)) {
        const { prompt, replyToMessage } = promptBuffer.get(userId);
        promptBuffer.delete(userId);
        processVeoRequest(userId, prompt, replyToMessage);
    }
};

bot.on('message', (msg) => {
    const userId = msg.from.id;
    const text = msg.text || '';
    if (text.startsWith('/')) return; 

    if (promptBuffer.has(userId)) {
        const userData = promptBuffer.get(userId);
        userData.prompt += ' ' + text;
        clearTimeout(userData.timeoutId);
        userData.timeoutId = setTimeout(() => finalizeAndProcessPrompt(userId), PROMPT_BUFFER_TIMEOUT);
        promptBuffer.set(userId, userData);
    }
});

bot.onText(/^\/veo/i, (msg) => {
    const userId = msg.from.id;
    const text = msg.text || '';
    
    if (promptBuffer.has(userId)) {
        clearTimeout(promptBuffer.get(userId).timeoutId);
        finalizeAndProcessPrompt(userId);
    }

    const initialPrompt = text.replace(/^\/veo\s*/i, '').trim();

    const timeoutId = setTimeout(() => finalizeAndProcessPrompt(userId), PROMPT_BUFFER_TIMEOUT);
    promptBuffer.set(userId, { 
        prompt: initialPrompt, 
        timeoutId: timeoutId, 
        replyToMessage: msg.reply_to_message 
    });
});

// --- OWNER COMMANDS ---
bot.onText(/^\/approve (\d+)$/, async (msg, match) => {
    if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, getLang("notOwner"));
    const userIdToApprove = parseInt(match[1], 10);
    try {
        const user = await User.findOne({ userId: userIdToApprove });
        if (!user) return bot.sendMessage(msg.chat.id, getLang("userNotFound", userIdToApprove));
        if (user.isApproved) return bot.sendMessage(msg.chat.id, getLang("userAlreadyApproved", user.firstName));
        user.isApproved = true;
        await user.save();
        bot.sendMessage(msg.chat.id, getLang("userApproved", user.firstName, userIdToApprove), { parse_mode: 'Markdown' });
        bot.sendMessage(userIdToApprove, getLang("startMessageApproved"), { parse_mode: 'Markdown' });
    } catch (error) {
        console.error("Error in /approve handler:", error);
        bot.sendMessage(msg.chat.id, getLang("error"));
    }
});

bot.onText(/^\/users$/, async (msg) => {
    if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, getLang("notOwner"));
    try {
        const users = await User.find({});
        if (users.length === 0) return bot.sendMessage(msg.chat.id, getLang("noUsers"));
        let userList = getLang("userListHeader");
        users.forEach(u => {
            userList += getLang("userListEntry", u.firstName, u.userId, u.isApproved ? "Yes" : "No", u.requestsMade);
        });
        bot.sendMessage(msg.chat.id, userList, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error("Error in /users handler:", error);
        bot.sendMessage(msg.chat.id, getLang("error"));
    }
});

// --- Graceful shutdown ---
const gracefulShutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down bot...`);
    try {
        await bot.stopPolling();
        await mongoose.connection.close();
        console.log('MongoDB connection closed and bot polling stopped.');
    } catch (error) {
        console.error('Error during graceful shutdown:', error);
    } finally {
        process.exit(0);
    }
};
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

