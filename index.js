require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

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
let adminPricingFor = null; // Tracks which user admin is setting price for

// Webhook endpoint
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Set webhook
bot.setWebHook(`${URL}/bot${token}`);

// Helper functions
function getServiceName(num) {
  return {
    1: "PPT Creation",
    2: "Notes Making",
    3: "Resume Building",
    4: "Assignment Formatting",
  }[num];
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
  orders[chatId] = { step: "chooseService" };
  bot.sendMessage(chatId, `👋 Welcome to DeadlineDesk Bot!`);
});

// ======================
// Admin Interaction and payments (all callback queries)
// ======================
bot.on("callback_query", async (callbackQuery) => {
  const data = callbackQuery.data;
  const fromId = callbackQuery.from.id.toString();
  const messageChatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const ADMIN_ID = process.env.ADMIN_ID;

  const isAdmin = ADMIN_ID && fromId === ADMIN_ID;

  try {
    // =====================================
    // ADMIN: ACCEPT ORDER
    // =====================================
    if (data.startsWith("accept_")) {
      if (!isAdmin)
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Only admin allowed.",
          show_alert: true,
        });

      const userId = data.split("_")[1];
      if (!orders[userId])
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: "Order not found",
          show_alert: true,
        });

      orders[userId].step = "setPrice";
      adminPricingFor = userId;

      await bot.sendMessage(
        ADMIN_ID,
        `💲Please Enter price for User ID: ${userId}`,
      );
    }

    // =====================================
    // ADMIN: REJECT ORDER
    // =====================================
    else if (data.startsWith("reject_")) {
      if (!isAdmin)
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Only admin allowed.",
          show_alert: true,
        });

      const userId = data.split("_")[1];
      if (!orders[userId]) return;

      await bot.sendMessage(
        userId,
        "❌ Sorry, we cannot take this project right now.",
      );

      delete orders[userId];

      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: messageChatId, message_id: messageId },
      );
    }

    // =====================================
    // USER: ACCEPT PRICE
    // =====================================
    // =====================================
    // USER: ACCEPT PRICE
    // =====================================
    else if (data.startsWith("price_accept_")) {
      const userId = data.replace("price_accept_", "").toString();

      // Check if the callback is from the correct user
      if (fromId.toString() !== userId) {
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Not allowed.",
          show_alert: true,
        });
      }

      const order = orders[userId];

      // Ensure order exists and price is set
      if (!order || !order.price) {
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: "⚠️ Price not found.",
          show_alert: true,
        });
      }

      const amount = order.price;
      const upiId = process.env.UPI_ID;

      if (!upiId) {
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: "⚠️ UPI not configured.",
          show_alert: true,
        });
      }

      const name = process.env.BUSINESS_NAME || "Payment";

      // Create UPI payment link
      const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR`;

      try {
        // Generate QR code in memory (buffer) — no need to save to file
        const qrBuffer = await QRCode.toBuffer(upiLink);

        // Update order step
        order.step = "awaitPayment";

        // Send QR code to user
        await bot.sendPhoto(userId, qrBuffer, {
          caption: `💳 Payment Details:

Amount: ₹${amount}
Payee Name: ${name}

Scan the QR code to pay. Once done, click "Payment Done".`,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Payment Done",
                  callback_data: `payment_done_${userId}`,
                },
              ],
            ],
          },
        });

        // Answer callback query to remove loading
        await bot.answerCallbackQuery(callbackQuery.id);
      } catch (err) {
        console.error("QR code generation error:", err);
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "⚠️ Failed to generate QR code. Please try again.",
          show_alert: true,
        });
      }
    }

    // =====================================
    // USER: REJECT PRICE
    // =====================================
    else if (data.startsWith("price_reject_")) {
      const userId = data.split("_")[2];

      if (fromId !== userId) return bot.answerCallbackQuery(callbackQuery.id);

      if (!orders[userId]) return;

      await bot.sendMessage(
        userId,
        "❌ You rejected the price. Order cancelled.",
      );

      // 🔔 Notify Admin
      await bot.sendMessage(ADMIN_ID, `❌ User ${userId} rejected the price.`);

      delete orders[userId];
    }

    // =====================================
    // USER: PAYMENT DONE
    // =====================================
    else if (data.startsWith("payment_done_")) {
      const userId = data.split("_")[2];

      if (fromId !== userId) return bot.answerCallbackQuery(callbackQuery.id);

      if (!orders[userId]) return;

      orders[userId].step = "waitingScreenshot";

      await bot.sendMessage(
        userId,
        "📸 Please send a screenshot of your payment for verification.",
      );

      // 🔔 Notify Admin
      await bot.sendMessage(
        ADMIN_ID,
        `📥 User ${userId} says payment done. Waiting for screenshot.`,
      );
    }

    // =====================================
    // ADMIN: APPROVE PAYMENT
    // =====================================
    else if (data.startsWith("approve_")) {
      if (!isAdmin)
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Only admin allowed.",
          show_alert: true,
        });

      const userId = data.split("_")[1];
      if (!orders[userId]) return;

      if (!orders[userId].fullFileId)
        return bot.sendMessage(ADMIN_ID, "⚠️ Full file not uploaded yet.");

      await bot.sendDocument(userId, orders[userId].fullFileId, {
        caption: "🎉 Payment verified! Here is your completed work.",
      });

      orders[userId].step = "completed";

      await bot.sendMessage(
        ADMIN_ID,
        `✅ Payment approved. File sent to ${userId}`,
      );

      delete orders[userId];
    }

    // =====================================
    // ADMIN: REJECT PAYMENT
    // =====================================
    else if (data.startsWith("rejectpay_")) {
      if (!isAdmin)
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ Only admin allowed.",
          show_alert: true,
        });

      const userId = data.split("_")[1];
      if (!orders[userId]) return;

      orders[userId].step = "awaitPayment";

      await bot.sendMessage(
        userId,
        "❌ Payment rejected. Please send correct screenshot.",
      );
    }

    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error("Callback Error:", error);

    bot.answerCallbackQuery(callbackQuery.id, {
      text: "⚠️ Something went wrong.",
      show_alert: true,
    });
  }
});

// Handle messages
bot.on("message", async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id.toString();
  const text = msg.text;
  const ADMIN_ID = process.env.ADMIN_ID;

  const isAdmin = ADMIN_ID && userId === ADMIN_ID;

  // =========================
  // PREVENT NON-TEXT CRASH
  // =========================
  if (!text) return;

  // =========================
  // ADMIN SECTION
  // =========================
  if (isAdmin) {
    // ---- /review command ----
    if (text === "/review") {
      const pendingOrders = Object.entries(orders).filter(
        ([id, order]) => order.step === "pendingReview",
      );

      if (pendingOrders.length === 0) {
        return bot.sendMessage(chatId, "No pending orders.");
      }

      for (const [id, order] of pendingOrders) {
        await bot.sendMessage(
          chatId,
          `📌 Order from User: ${id}
Service: ${getServiceName(order.service)}
Details: ${order.details}
Deadline: ${order.deadline}`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Accept", callback_data: `accept_${id}` },
                  { text: "Reject", callback_data: `reject_${id}` },
                ],
              ],
            },
          },
        );
      }

      return;
    }

    // ---- Admin entering price ----
    if (adminPricingFor) {
      const price = parseInt(text);

      if (isNaN(price)) {
        return bot.sendMessage(chatId, "❌ Please enter a valid number.");
      }

      const targetUser = adminPricingFor;

      if (!orders[targetUser]) {
        adminPricingFor = null;
        return bot.sendMessage(chatId, "⚠️ Order not found.");
      }

      orders[targetUser].price = price;
      orders[targetUser].step = "awaitUserApproval";

      await bot.sendMessage(
        targetUser,
        `✅ Your order has been accepted!
Price: ₹${price}
Do you accept this price?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Yes, I accept",
                  callback_data: `price_accept_${targetUser}`,
                },
              ],
              [
                {
                  text: "No, I reject",
                  callback_data: `price_reject_${targetUser}`,
                },
              ],
            ],
          },
        },
      );

      await bot.sendMessage(chatId, `💰 Price sent to User ID: ${targetUser}`);

      adminPricingFor = null; // reset
      return;
    }

    return; // Stop admin flow here
  }

  // =========================
  // USER SECTION
  // =========================

  if (text === "/start") {
    orders[chatId] = { step: "chooseService" };
    return bot.sendMessage(
      chatId,
      `👋 Welcome to DeadlineDesk Bot!

Choose a service:
1️⃣ PPT Creation
2️⃣ Notes Making
3️⃣ Resume Building
4️⃣ Assignment Formatting`,
    );
  }

  if (!orders[chatId]) {
    return bot.sendMessage(chatId, "Type /start to begin.");
  }

  const step = orders[chatId].step;

  // Step 1: Choose Service
  if (step === "chooseService") {
    if (["1", "2", "3", "4"].includes(text)) {
      orders[chatId].service = text;
      orders[chatId].step = "getDetails";

      return bot.sendMessage(
        chatId,
        `You chose *${getServiceName(text)}*.
Please send the topic/details (clear description of the project helps the better results). `,
        { parse_mode: "Markdown" },
      );
    }

    return bot.sendMessage(chatId, "❌ Please choose 1, 2, 3, or 4.");
  }

  // Step 2: Get Details
  if (step === "getDetails") {
    orders[chatId].details = text;
    orders[chatId].step = "getDeadline";

    return bot.sendMessage(
      chatId,
      "Please send the deadline (e.g., 25 Feb 6 PM). Try to write specific date and time.",
    );
  }

  // Step 3: Get Deadline
  if (step === "getDeadline") {
    orders[chatId].deadline = text;
    orders[chatId].step = "pendingReview";

    await bot.sendMessage(
      chatId,
      "✅ Your order is under review. We will notify you once it will approved. Thank you for your support and patience.",
    );

    if (ADMIN_ID) {
      await bot.sendMessage(ADMIN_ID, createAdminMessage(chatId), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Accept", callback_data: `accept_${chatId}` },
              { text: "Reject", callback_data: `reject_${chatId}` },
            ],
          ],
        },
      });
    }

    return;
  }
});

// ======================
// Manual Partial Delivery
// ======================
bot.onText(/\/sendpartial/, (msg) => {
  const chatId = msg.chat.id.toString();

  if (!orders[chatId]) {
    bot.sendMessage(chatId, "No active order found.");
    return;
  }

  if (
    orders[chatId].step !== "awaitPayment" &&
    orders[chatId].step !== "inProgress"
  ) {
    bot.sendMessage(chatId, "Your order is not ready for partial delivery.");
    return;
  }

  const filePath = path.join(__dirname, "files/partial", `${chatId}.pdf`);

  if (fs.existsSync(filePath)) {
    bot.sendDocument(chatId, filePath, {
      caption: "✅ Here is 40% of your work. Please check and send payment.",
    });
  } else {
    bot.sendMessage(
      chatId,
      "⏳ Your work is still in process. Please check again later.",
    );
  }
});

// ======================
// document sending
// ======================

bot.on("document", async (msg) => {
  const ADMIN_ID = process.env.ADMIN_ID;
  const senderId = msg.from.id.toString();

  // Only admin can upload
  if (senderId !== ADMIN_ID) return;

  const caption = (msg.caption || "").trim();
  if (!caption.includes("_")) {
    return bot.sendMessage(
      senderId,
      "⚠️ Wrong format! Use: userId_partial OR userId_full"
    );
  }

  // Split on last underscore (safer)
  const lastUnderscore = caption.lastIndexOf("_");
  const userId = caption.slice(0, lastUnderscore).trim();
  const type = caption.slice(lastUnderscore + 1).trim().toLowerCase();

  if (!orders[userId]) {
    return bot.sendMessage(senderId, `❌ No active order found for user ID ${userId}`);
  }

  const fileId = msg.document.file_id;

  // ---- PARTIAL FILE ----
  if (type === "partial") {
    orders[userId].partialFileId = fileId;
    await bot.sendMessage(senderId, `✅ Partial file saved for user ${userId}`);

    // Auto-send partial if user is waiting
    if (["awaitPayment", "inProgress"].includes(orders[userId].step)) {
      await bot.sendDocument(userId, fileId, {
        caption: "✅ Here is 40% of your work. Please check and complete the payment.",
      });
      orders[userId].step = "partialSent";
    }

  // ---- FULL FILE ----
  } else if (type === "full") {
    orders[userId].fullFileId = fileId;
    await bot.sendMessage(senderId, `✅ Full file saved for user ${userId}`);

    // Auto-send full if payment verified
    if (orders[userId].step === "verificationPending") {
      await bot.sendDocument(userId, fileId, {
        caption: "🎉 Payment verified! Here is your completed work.",
      });
      orders[userId].step = "completed";
    } else {
      // Payment not done yet
      await bot.sendMessage(userId, "✅ Your work is ready. Please complete the payment to receive it.");
    }

  } else {
    await bot.sendMessage(senderId, "❌ Wrong format! Use: userId_partial OR userId_full");
  }
});




// ======================
// screenshot verification
// ======================
bot.on("photo", (msg) => {
  const chatId = msg.chat.id.toString();

  if (!orders[chatId]) return;

  if (orders[chatId].step !== "waitingScreenshot") return;

  const ADMIN_ID = process.env.ADMIN_ID;

  const photoId = msg.photo[msg.photo.length - 1].file_id;

  // After sending screenshot to admin
  bot.sendPhoto(ADMIN_ID, photoId, {
    caption: `💰 Payment screenshot from user ${chatId}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: `approve_${chatId}` },
          { text: "Reject", callback_data: `rejectpay_${chatId}` },
        ],
      ],
    },
  });

  // Message to user based on work status
  if (!orders[chatId].workDone) {
    bot.sendMessage(
      chatId,
      "✅ Payment verified. Please wait while your work is in progress...",
    );
  } else {
    bot.sendMessage(chatId, "✅ Payment verified. Here is your project:", {
      // Example: send document or project file
      document: orders[chatId].projectFile,
    });
  }

  // Update step
  orders[chatId].step = "verificationPending";
});

// ======================
// Express server
// ======================
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
