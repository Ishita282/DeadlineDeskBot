const TelegramBot = require("node-telegram-bot-api");

// Your bot token from BotFather
const token = "8446951746:AAHTKrIf9NQM62OlegyUa1LZck5BCzXD3S0";

// Create bot
const bot = new TelegramBot(token, { polling: true });

// Object to store user data temporarily
const userData = {};

// Start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Welcome to DeadlineDesk Bot!\n\nWhich service do you want?\n\n1️⃣ PPT Creation\n2️⃣ Notes Making\n3️⃣ Resume Building\n4️⃣ Assignment Formatting`
  );
  userData[chatId] = { step: "chooseService" };
});

// Handle messages
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Ignore /start command
  if (text === "/start") return;

  // Initialize if not exist
  if (!userData[chatId]) userData[chatId] = { step: "chooseService" };

  const step = userData[chatId].step;

  if (step === "chooseService") {
    if (["1", "2", "3", "4"].includes(text)) {
      userData[chatId].service = text;
      if (text === "1") bot.sendMessage(chatId, "Please send the PPT topic and number of slides.");
      if (text === "2") bot.sendMessage(chatId, "Please send the subject and number of pages for notes.");
      if (text === "3") bot.sendMessage(chatId, "Please send your resume details or upload your current resume.");
      if (text === "4") bot.sendMessage(chatId, "Please send the assignment details and pages required.");
      userData[chatId].step = "getDetails";
    } else {
      bot.sendMessage(chatId, "Please choose a valid option: 1, 2, 3, or 4.");
    }
  } else if (step === "getDetails") {
    userData[chatId].details = text;
    bot.sendMessage(chatId, "Got it! Please send the deadline for this task (e.g., 25 Feb 6 PM).");
    userData[chatId].step = "getDeadline";
  } else if (step === "getDeadline") {
    userData[chatId].deadline = text;
    bot.sendMessage(
      chatId,
      `✅ Order Received!\n\n*Service:* ${
        {1:"PPT",2:"Notes",3:"Resume",4:"Assignment"}[userData[chatId].service]
      }\n*Details:* ${userData[chatId].details}\n*Deadline:* ${userData[chatId].deadline}\n\nWe will contact you shortly for payment.`
    );
    // Here you can send notification to yourself or save in Google Sheets
    console.log(`New Order from ${chatId}:`, userData[chatId]);
    userData[chatId] = { step: "chooseService" }; // Reset for new order
  }
});
