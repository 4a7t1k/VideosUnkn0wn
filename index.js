require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const mongoose = require('mongoose');

// --- CONFIG ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g., https://your-app.onrender.com
const VEO_API_KEY = process.env.VEO_API_KEY;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const MONGO_URI = process.env.MONGO_URI;
const OWNER_ID = parseInt(process.env.OWNER_ID);
const OWNER_USERNAME = process.env.OWNER_USERNAME;
const FREE_TIER_LIMIT = parseInt(process.env.FREE_TIER_LIMIT) || 1;

// --- CONSTANTS ---
const PROMPT_BUFFER_TIMEOUT = 20000;
const promptBuffer = new Map();
const VEO_API_URL = "https://api.paxsenix.org/ai-video/veo-3";
const VALID_RATIOS = ["16:9", "9:16"];
const VALID_MODELS = ["veo-3"];
const TEMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// --- MONGODB SETUP ---
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

// --- LANGUAGES ---
const langs = {
    en: {
        startMessage: "👋 Welcome to Veo AI Bot!\n\nYou have **1 free video generation** to try out the bot. Use /veo to start!",
        startMessageReturningTrial: "👋 Welcome back! You still have your free video trial. Use /veo to create your video.",
        startMessageApproved: "👋 Welcome back! Your account is approved for **unlimited** video generations.",
        startMessageOwner: "👋 Welcome, Owner! You have unlimited access. Use /veo to begin.",
        limitReached: "⚠️ You have used your free trial.\nPlease wait for the owner (%1) to approve your account for unlimited access.",
        ownerNotified: "👤 New user started the bot:\nName: %1 (@%2)\nID: `%3`\nUse `/approve %3` to give unlimited access.",
        userNotFound: "❌ User with ID %1 not found.",
        userAlreadyApproved: "✅ User %1 is already approved.",
        userApproved: "✅ User %1 (`%2`) has been approved for unlimited access!",
        userListHeader: "--- User List ---\n\n",
        userListEntry: "👤 Name: %1\n🆔 ID: `%2`\n✅ Approved: %3\n▶️ Requests: %4\n\n",
        noUsers: "No users found in the database yet.",
        notOwner: "❌ This command can only be used by the owner.",
        noPrompt: "Please provide a prompt or reply to an image with /veo.\nExample: `/veo a beautiful sunset`",
        sending: "⏳ Sending request... This may take a few minutes.",
        apiFailed: "❌ API failed to return job info. Try again later.",
        requestSent: "✅ Request sent successfully!\nJob ID: %1\nNow polling for results...",
        noResults: "❌ No results returned within the time limit.",
        noVideo: "❌ No video found in API response.",
        downloadFailed: "❌ Failed to download or send video.",
        error: "❌ Unexpected error occurred. Try again later.",
        videoCaption: "✅ Video sent as a document for best quality."
    }
};
const getLang = (key, ...args) => {
    let text = langs.en[key] || "Language string not found.";
    args.forEach((arg, i) => text = text.replace(`%${i+1}`, arg));
    return text;
};

// --- HELPERS ---
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
    } catch (err) {
        console.error("ImgBB Upload Error:", err.response ? err.response.data : err.message);
        return null;
    }
}

function extractMp4Urls(obj) {
    const urls = [];
    function search(value) {
        if (!value) return;
        if (typeof value === "string" && value.toLowerCase().endsWith(".mp4")) urls.push(value);
        else if (Array.isArray(value)) value.forEach(search);
        else if (typeof value === "object") for (const k in value) search(value[k]);
    }
    search(obj);
    return [...new Set(urls)];
}

// --- TELEGRAM BOT (WEBHOOK) ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
bot.setWebHook(`${WEBHOOK_URL}/${TELEGRAM_BOT_TOKEN}`);

const app = express();
app.use(bodyParser.json());
app.post(`/${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// --- PROCESS VIDEO REQUEST ---
async function processVeoRequest(chatId, fullPrompt, replyToMessage) {
    let waitingMsg;
    try {
        let user;
        if (chatId !== OWNER_ID) {
            user = await User.findOne({ userId: chatId });
            if (!user) return bot.sendMessage(chatId, getLang("error"));
            if (!user.isApproved && user.requestsMade >= FREE_TIER_LIMIT)
                return bot.sendMessage(chatId, getLang("limitReached", OWNER_USERNAME));
        }

        let prompt, ratio = "9:16", model = "veo-3";
        const args = fullPrompt.split(/\s+/).filter(Boolean);
        const ratioIndex = args.findIndex(a => a.toLowerCase() === "--ar");
        if (ratioIndex !== -1) { ratio = args[ratioIndex+1]; args.splice(ratioIndex,2); }
        const potentialModel = args[args.length-1];
        if (VALID_MODELS.includes(potentialModel)) { model = potentialModel; args.pop(); }
        prompt = args.join(" ").trim();

        let imageUrls = [];
        if (replyToMessage && replyToMessage.photo) {
            if (!prompt) return bot.sendMessage(chatId, getLang("noPrompt"));
            const photo = replyToMessage.photo[replyToMessage.photo.length-1];
            const fileLink = await bot.getFileLink(photo.file_id);
            const filePath = path.join(TEMP_DIR, `tg_img_${Date.now()}.jpg`);
            try {
                await downloadFile(fileLink, filePath);
                const uploadedUrl = await uploadToImgbb(filePath);
                if (!uploadedUrl) return bot.sendMessage(chatId, getLang("downloadFailed"));
                imageUrls.push(uploadedUrl);
            } finally { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
        } else if (!prompt) return bot.sendMessage(chatId, getLang("noPrompt"));

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
        const maxWaitSeconds = 600, checkInterval = 5000;
        for (let i=0; i<maxWaitSeconds/checkInterval; i++) {
            await new Promise(r => setTimeout(r, checkInterval));
            try {
                const tRes = await axios.get(taskUrl, { headers: { Authorization: `Bearer ${VEO_API_KEY}` } });
                if (tRes.data && (tRes.data.status==="done" || tRes.data.status==="success" || tRes.data.url || tRes.data.data)) {
                    taskData = tRes.data; break;
                }
            } catch {}
        }
        if (!taskData) return bot.editMessageText(getLang("noResults"), { chat_id: chatId, message_id: waitingMsg.message_id });
        await bot.deleteMessage(chatId, waitingMsg.message_id);

        let mp4Urls = extractMp4Urls(taskData);
        if (taskData.url?.toLowerCase().endsWith(".mp4")) mp4Urls.push(taskData.url);
        if (!mp4Urls.length) return bot.sendMessage(chatId, getLang("noVideo"));

        let videosSent = 0;
        for (const videoUrl of [...new Set(mp4Urls)]) {
            const videoPath = path.join(TEMP_DIR, `veo_result_${Date.now()}.mp4`);
            try {
                await downloadFile(videoUrl, videoPath);
                await bot.sendDocument(chatId, videoPath, { caption: getLang("videoCaption") });
                videosSent++;
            } catch { await bot.sendMessage(chatId, getLang("downloadFailed")); }
            finally { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); }
        }

        if (videosSent>0 && chatId!==OWNER_ID && user) { user.requestsMade+=1; await user.save(); }
    } catch (err) { console.error(err); if (waitingMsg) await bot.editMessageText(getLang("error"), { chat_id: chatId, message_id: waitingMsg.message_id }); else await bot.sendMessage(chatId, getLang("error")); }
}

// --- /start Handler ---
bot.onText(/^\/start$/, async msg => {
    const { id: userId, username, first_name } = msg.from;
    try {
        if (userId===OWNER_ID) return bot.sendMessage(userId, getLang("startMessageOwner"));

        let user = await User.findOne({ userId });
        if (!user) {
            user = new User({ userId, username: username||'N/A', firstName: first_name||'User' });
            await user.save();
            bot.sendMessage
            (OWNER_ID, getLang("ownerNotified", first_name, username, userId), { parse_mode:'Markdown' });
            return bot.sendMessage(userId, getLang("startMessage"), { parse_mode:'Markdown' });
        } else {
            if (user.isApproved) return bot.sendMessage(userId, getLang("startMessageApproved"), { parse_mode:'Markdown' });
            else if (user.requestsMade < FREE_TIER_LIMIT) return bot.sendMessage(userId, getLang("startMessageReturningTrial"), { parse_mode:'Markdown' });
            else return bot.sendMessage(userId, getLang("limitReached", OWNER_USERNAME));
        }
    } catch (err) {
        console.error(err);
        bot.sendMessage(userId, getLang("error"));
    }
});

// --- /veo Handler ---
const finalizeAndProcessPrompt = userId => {
    if (promptBuffer.has(userId)) {
        const { prompt, replyToMessage } = promptBuffer.get(userId);
        promptBuffer.delete(userId);
        processVeoRequest(userId, prompt, replyToMessage);
    }
};

bot.on('message', msg => {
    const userId = msg.from.id;
    const text = msg.text || '';
    if (text.startsWith('/')) return;
    if (promptBuffer.has(userId)) {
        const data = promptBuffer.get(userId);
        data.prompt += ' ' + text;
        clearTimeout(data.timeoutId);
        data.timeoutId = setTimeout(() => finalizeAndProcessPrompt(userId), PROMPT_BUFFER_TIMEOUT);
        promptBuffer.set(userId, data);
    }
});

bot.onText(/^\/veo/i, msg => {
    const userId = msg.from.id;
    const initialPrompt = (msg.text || '').replace(/^\/veo\s*/i,'').trim();
    const timeoutId = setTimeout(() => finalizeAndProcessPrompt(userId), PROMPT_BUFFER_TIMEOUT);
    promptBuffer.set(userId, { prompt: initialPrompt, timeoutId, replyToMessage: msg.reply_to_message });
});

// --- OWNER COMMANDS ---
bot.onText(/^\/approve (\d+)$/, async (msg, match) => {
    if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, getLang("notOwner"));
    const uid = parseInt(match[1]);
    const user = await User.findOne({ userId: uid });
    if (!user) return bot.sendMessage(msg.chat.id, getLang("userNotFound", uid));
    if (user.isApproved) return bot.sendMessage(msg.chat.id, getLang("userAlreadyApproved", user.firstName));
    user.isApproved = true;
    await user.save();
    bot.sendMessage(msg.chat.id, getLang("userApproved", user.firstName, uid), { parse_mode:'Markdown' });
    bot.sendMessage(uid, getLang("startMessageApproved"), { parse_mode:'Markdown' });
});

bot.onText(/^\/users$/, async msg => {
    if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, getLang("notOwner"));
    const users = await User.find({});
    if (!users.length) return bot.sendMessage(msg.chat.id, getLang("noUsers"));
    let list = getLang("userListHeader");
    users.forEach(u => list += getLang("userListEntry", u.firstName, u.userId, u.isApproved ? "Yes" : "No", u.requestsMade));
    bot.sendMessage(msg.chat.id, list, { parse_mode:'Markdown' });
});

// --- START EXPRESS SERVER ---
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Veo AI Bot is running.'));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
