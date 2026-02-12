require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token); // no polling
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const URL = process.env.RENDER_URL;

const orders = {}; // temporary storage of orders

// Webhook endpoint
app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Set webhook (Telegram pushes updates)
bot.setWebHook(`${URL}/bot${token}`);

// Helper function: get service name
function getServiceName(num) {
    return { '1': 'PPT Creation', '2': 'Notes Making', '3': 'Resume Building', '4': 'Assignment Formatting' }[num];
}

// Start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    orders[chatId] = { step: 'chooseService' };
    bot.sendMessage(chatId, `👋 Welcome to DeadlineDesk Bot!\n\nChoose a service:\n1️⃣ PPT Creation\n2️⃣ Notes Making\n3️⃣ Resume Building\n4️⃣ Assignment Formatting`);
});

// Message handler
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
            bot.sendMessage(chatId, `You chose *${getServiceName(text)}*.\nPlease send the topic/details for your task.`);
            orders[chatId].step = 'getDetails';
        } else {
            bot.sendMessage(chatId, 'Please choose a valid option: 1,2,3,4');
        }

    // Step 2: Get task details
    } else if (step === 'getDetails') {
        orders[chatId].details = text;
        bot.sendMessage(chatId, 'Please send the deadline for your task (e.g., 25 Feb 6 PM).');
        orders[chatId].step = 'getDeadline';

    // Step 3: Get deadline
    } else if (step === 'getDeadline') {
        orders[chatId].deadline = text;
        bot.sendMessage(chatId, '✅ Order received! We will send 40% of your work a day before deadline.');
        
        // Notify admin
        if (process.env.ADMIN_ID) {
            bot.sendMessage(process.env.ADMIN_ID, `New Order:\nService: ${getServiceName(orders[chatId].service)}\nDetails: ${orders[chatId].details}\nDeadline: ${orders[chatId].deadline}\nUser: ${chatId}`);
        }

        orders[chatId].step = 'awaitPayment';
    }

    // Step 4: After payment confirmation - send full work (manual)
    else if (text.toLowerCase() === 'payment done') {
        if (orders[chatId] && orders[chatId].step === 'awaitPayment') {
            // Send full work from files/full
            const fullFiles = fs.readdirSync(path.join(__dirname, 'files/full'));
            fullFiles.forEach(file => {
                bot.sendDocument(chatId, path.join(__dirname, 'files/full', file), { caption: '🎉 Here is your full completed work!' });
            });
            bot.sendMessage(chatId, 'Thank you for your payment! Your order is complete.');
            orders[chatId].step = 'completed';
        }
    }
});

// Optional: manual trigger for partial delivery
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

// Express server
app.listen(PORT, () => {
    console.log(`Bot running on port ${PORT}`);
});
