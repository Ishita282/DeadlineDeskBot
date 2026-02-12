require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error("❌ BOT_TOKEN missing in environment variables!");
    process.exit(1);
}

const bot = new TelegramBot(token); // no polling
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const URL = process.env.RENDER_URL;
if (!URL) {
    console.error("❌ RENDER_URL missing in environment variables!");
    process.exit(1);
}

// Store all orders
const orders = {}; // { chatId: { step, service, details, deadline, status, price } }

// Webhook endpoint
app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Set webhook
bot.setWebHook(`${URL}/bot${token}`);

// Helper functions
function getServiceName(num) {
    return { '1': 'PPT Creation', '2': 'Notes Making', '3': 'Resume Building', '4': 'Assignment Formatting' }[num];
}

function createAdminMessage(chatId) {
    const order = orders[chatId];
    return `📌 New Order:\nService: ${getServiceName(order.service)}\nDetails: ${order.details}\nDeadline: ${order.deadline}\nUser ID: ${chatId}`;
}

// ======================
// User / Client Workflow
// ======================

// /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    orders[chatId] = { step: 'chooseService' };
    bot.sendMessage(chatId, `👋 Welcome to DeadlineDesk Bot!\n\nChoose a service:\n1️⃣ PPT Creation\n2️⃣ Notes Making\n3️⃣ Resume Building\n4️⃣ Assignment Formatting`);
});

// Handle messages
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore /start
    if (text === '/start') return;

    // Initialize if not exists
    if (!orders[chatId]) orders[chatId] = { step: 'chooseService' };

    const step = orders[chatId].step;

    // Step 1: Choose service
    if (step === 'chooseService') {
        if (['1','2','3','4'].includes(text)) {
            orders[chatId].service = text;
            orders[chatId].step = 'getDetails';
            bot.sendMessage(chatId, `You chose *${getServiceName(text)}*.\nPlease send the topic/details for your task.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '❌ Please choose a valid option: 1,2,3,4');
        }
    }

    // Step 2: Get task details
    else if (step === 'getDetails') {
        orders[chatId].details = text;
        orders[chatId].step = 'getDeadline';
        bot.sendMessage(chatId, 'Please send the deadline for your task (e.g., 25 Feb 6 PM).');
    }

    // Step 3: Get deadline → notify admin
    else if (step === 'getDeadline') {
        orders[chatId].deadline = text;
        orders[chatId].step = 'pendingReview';
        bot.sendMessage(chatId, '✅ Your order has been received and is under review. You will be notified once we accept it.');

        // Notify admin
        if (process.env.ADMIN_ID) {
            bot.sendMessage(process.env.ADMIN_ID, createAdminMessage(chatId), {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Accept', callback_data: `accept_${chatId}` },
                            { text: 'Reject', callback_data: `reject_${chatId}` }
                        ]
                    ]
                }
            });
        }
    }

    // Payment confirmation (manual trigger)
    else if (text.toLowerCase() === 'payment done') {
        if (orders[chatId] && orders[chatId].step === 'awaitPayment') {
            const fullFiles = fs.readdirSync(path.join(__dirname, 'files/full'));
            fullFiles.forEach(file => {
                bot.sendDocument(chatId, path.join(__dirname, 'files/full', file), { caption: '🎉 Here is your full completed work!' });
            });
            bot.sendMessage(chatId, 'Thank you for your payment! Your order is complete.');
            orders[chatId].step = 'completed';
        }
    }
});

// ======================
// Admin Interaction (Accept/Reject + Price)
// ======================

bot.on('callback_query', (callbackQuery) => {
    const data = callbackQuery.data;
    const adminId = callbackQuery.from.id;
    const chatId = callbackQuery.message.chat.id;

    // Only allow ADMIN_ID to accept/reject
    if (process.env.ADMIN_ID && adminId.toString() !== process.env.ADMIN_ID) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ You are not authorized.' });
        return;
    }

    // Parse callback
    if (data.startsWith('accept_')) {
        const userId = data.split('_')[1];
        orders[userId].step = 'setPrice';
        bot.sendMessage(adminId, `Enter the price for order of User ID: ${userId}`);
    }

    else if (data.startsWith('reject_')) {
        const userId = data.split('_')[1];
        orders[userId].step = 'rejected';
        bot.sendMessage(userId, '❌ Sorry, we cannot take this project at this time. You may contact us for future tasks.');
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });
    }
});

// Admin enters price → send to client
bot.on('message', (msg) => {
    const adminId = msg.from.id;
    if (process.env.ADMIN_ID && adminId.toString() === process.env.ADMIN_ID) {
        // Find any order in setPrice step
        const pendingPriceOrder = Object.entries(orders).find(([uid, order]) => order.step === 'setPrice');
        if (pendingPriceOrder) {
            const [userId, order] = pendingPriceOrder;
            const price = parseInt(msg.text);
            if (isNaN(price)) {
                bot.sendMessage(adminId, '❌ Please enter a valid number for price.');
                return;
            }

            orders[userId].price = price;
            orders[userId].step = 'awaitUserApproval';

            // Send price proposal to client
            bot.sendMessage(userId, `✅ Your order has been accepted!\nPrice: ₹${price}\nDo you accept this price?`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Yes, I accept', callback_data: `price_accept_${userId}` }],
                        [{ text: 'No, I reject', callback_data: `price_reject_${userId}` }]
                    ]
                }
            });

            bot.sendMessage(adminId, `Price proposal sent to User ID: ${userId}`);
        }
    }
});

// Handle price approval/rejection
bot.on('callback_query', (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    if (data.startsWith('price_accept_')) {
        const userId = data.split('_')[2];
        orders[userId].step = 'awaitPayment';
        bot.sendMessage(userId, '🎉 Price accepted! You can now send payment. After payment, you will receive the full work.');
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });
    }

    else if (data.startsWith('price_reject_')) {
        const userId = data.split('_')[2];
        orders[userId].step = 'rejected';
        bot.sendMessage(userId, '❌ You rejected the price. Order cancelled.');
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });
    }
});

// ======================
// Manual Partial Delivery
// ======================
bot.onText(/\/sendpartial/, (msg) => {
    const chatId = msg.chat.id;
    if (orders[chatId] && orders[chatId].step === 'awaitPayment') {
        const partialFiles = fs.readdirSync(path.join(__dirname, 'files/partial'));
        partialFiles.forEach(file => {
            bot.sendDocument(chatId, path.join(__dirname, 'files/partial', file), { caption: '✅ Here is 40% of your work. Please check and send payment.' });
        });
    } else {
        bot.sendMessage(chatId, 'No active order found to send partial work.');
    }
});

// ======================
// Express server
// ======================
app.listen(PORT, () => {
    console.log(`Bot running on port ${PORT}`);
});
