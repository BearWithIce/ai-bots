import crypto from "crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder
} from "discord.js";

import {
  getNextOrderNumber,
  getNextInvoiceNumber,
  initFirebase,
  saveRenewal as saveRenewalDb,
  getRenewal as getRenewalDb,
  updateRenewal as updateRenewalDb,
  saveOrder,
  getOrder,
  updateOrder,
  saveDiscountCode,
  getDiscountCode,
  saveInvoice
} from "./firebase.js";

import {
  calculateInvoice,
  createInvoiceFiles
} from "./invoice.js";

import {
  addInvoice,
  addTransaction,
  addOrder
} from "./googleSheets.js";

import {
  sendOrderOtp,
  sendInvoiceEmail
} from "./email.js";

/* ============================================================
   CONFIGURATION
============================================================ */

const OTP_TTL_MS = 10 * 60 * 1000;
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;

const ADMIN_VERIFICATION_CHANNEL_ID =
  "1483657607712346202";

const ADMIN_VERIFICATION_ROLE_IDS = [
  "1455830550333100062",
  "1455830590195761250",
  "1455830592515215545"
];

/* ============================================================
   PAYMENT METHODS
============================================================ */

const PAYPAL_HOSTED_PAYMENT_URL = "https://www.paypal.com/ncp/payment/ZVWVGJB8UL2FW";

const PAYMENTS = {
  other: {
    label: "Other Payment",
    emoji: "🌐",
    detail: () => "Pay securely through Aura Cloud's hosted payment page."
  },
  paypal: {
    label: "PayPal",
    emoji: "💸",
    detail: () => process.env.PAYPAL_DETAILS || "PAYPAL_DETAILS_NOT_CONFIGURED"
  },
  bank: {
    label: "Bank Transfer",
    emoji: "🏦",
    detail: () => process.env.BANK_TRANSFER_DETAILS || "BANK_TRANSFER_DETAILS_NOT_CONFIGURED"
  },
  card: {
    label: "Card Payment",
    emoji: "💳",
    detail: () => process.env.CARD_PAYMENT_DETAILS || "CARD_PAYMENT_DETAILS_NOT_CONFIGURED"
  },
  ezcash: {
    label: "eZ Cash",
    emoji: "📱",
    detail: () => process.env.EZCASH_DETAILS || "EZCASH_DETAILS_NOT_CONFIGURED"
  }
};

/* ============================================================
   ADMIN MESSAGE PERMISSION
============================================================ */

function isAdminMessage(message) {
  return Boolean(
    message.guildId === process.env.ALLOWED_GUILD_ID &&
    message.channelId === process.env.ALLOWED_CHANNEL_ID &&
    message.member?.roles?.cache?.has(
      process.env.ALLOWED_ROLE_ID
    )
  );
}

/* ============================================================
   ADMIN VERIFICATION PERMISSION
============================================================ */

function isVerificationAdmin(interaction) {
  if (!interaction.guildId) {
    return false;
  }

  if (
    process.env.ALLOWED_GUILD_ID &&
    interaction.guildId !== process.env.ALLOWED_GUILD_ID
  ) {
    return false;
  }

  return ADMIN_VERIFICATION_ROLE_IDS.some(
    roleId =>
      interaction.member?.roles?.cache?.has(roleId)
  );
}

/* ============================================================
   HELPERS
============================================================ */

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function money(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? Math.max(0, number)
    : 0;
}

function currencyOf(order) {
  return String(order?.currency || "LKR").toUpperCase() === "USD"
    ? "USD"
    : "LKR";
}

function formatMoney(value, currency = "LKR") {
  return `${currency} ${money(value).toLocaleString()}`;
}

function generateOtp() {
  return String(
    crypto.randomInt(100000, 1000000)
  );
}

function hashOtp(code) {
  return crypto
    .createHash("sha256")
    .update(String(code))
    .digest("hex");
}

/* ============================================================
   RENEWAL ID
============================================================ */

function generateRenewalId(orderNumber) {
  return `RENEW-${orderNumber}-${Date.now()}`;
}

/* ============================================================
   SERVER NAME
============================================================ */

function getServerName(order) {
  return (
    order.serverName ||
    order.server ||
    order.serviceName ||
    `Hosting Server - ${order.orderNumber}`
  );
}

/* ============================================================
   DISCOUNT EXPIRY PARSER
============================================================ */

function parseDuration(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();

  if (!raw) {
    return null;
  }

  const dateMatch = raw.match(
    /^(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ t](\d{1,2}):(\d{2}))?$/
  );

  if (dateMatch) {
    const [
      ,
      year,
      month,
      day,
      hour = "23",
      minute = "59"
    ] = dateMatch;

    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      59,
      999
    );

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date.toISOString();
  }

  const relative = raw.match(
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/
  );

  if (!relative) {
    return null;
  }

  const amount = Number(relative[1]);
  const unit = relative[2];

  let multiplier = 60 * 1000;

  if (
    /^(h|hr|hrs|hour|hours)$/.test(unit)
  ) {
    multiplier = 60 * 60 * 1000;
  } else if (
    /^(d|day|days)$/.test(unit)
  ) {
    multiplier = 24 * 60 * 60 * 1000;
  } else if (
    /^(w|week|weeks)$/.test(unit)
  ) {
    multiplier = 7 * 24 * 60 * 60 * 1000;
  }

  return new Date(
    Date.now() + amount * multiplier
  ).toISOString();
}

/* ============================================================
   DISCOUNT VALUE PARSER
============================================================ */

function parseDiscountValue(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return null;
  }

  const percent = raw.match(
    /^(\d+(?:\.\d+)?)\s*%$/
  );

  if (percent) {
    const amount = Number(percent[1]);

    if (amount <= 0 || amount > 100) {
      return null;
    }

    return {
      type: "percent",
      value: amount
    };
  }

  const fixed = raw.match(
    /^(\d+(?:\.\d+)?)\s*(?:lkr|rs)?$/i
  );

  if (fixed) {
    const amount = Number(fixed[1]);

    if (amount <= 0) {
      return null;
    }

    return {
      type: "fixed",
      value: amount
    };
  }

  return null;
}

/* ============================================================
   APPLY DISCOUNT
============================================================ */

async function applyDiscount(order, code) {
  if (!code) {
    return {
      valid: false,
      discount: 0,
      message: "No discount code used."
    };
  }

  const coupon = await getDiscountCode(
    normalizeCode(code)
  );

  if (!coupon) {
    return {
      valid: false,
      discount: 0,
      message: "Discount code not found."
    };
  }

  if (
    coupon.expiresAt &&
    new Date(coupon.expiresAt).getTime() <= Date.now()
  ) {
    return {
      valid: false,
      discount: 0,
      message: "Discount code has expired."
    };
  }

  if (coupon.active === false) {
    return {
      valid: false,
      discount: 0,
      message: "Discount code is disabled."
    };
  }

  const subtotal = money(order.price);

  let discount = 0;

  if (coupon.type === "percent") {
    discount =
      subtotal *
      (Number(coupon.value) / 100);
  } else {
    discount = Number(coupon.value || 0);
  }

  discount = Math.min(
    subtotal,
    Math.max(0, discount)
  );

  const currency = currencyOf(order);

  return {
    valid: true,
    discount,
    coupon,
    message:
      coupon.type === "percent"
        ? `${coupon.code}: ${coupon.value}% off`
        : `${coupon.code}: ${currency} ${Number(
            coupon.value
          ).toLocaleString()} off`
  };
}

/* ============================================================
   SPECIFICATION DISPLAY
============================================================ */

function specsText(order) {
  const currency = currencyOf(order);

  return [
    `RAM: **${order.ram || "Not specified"}**`,
    `Disk: **${order.disk || "Not specified"}**`,
    `CPU: **${order.cpu || "Not specified"}**`,
    `Location: **${order.location || "Not specified"}**`,
    `Price: **${formatMoney(
      order.price,
      currency
    )}**`
  ].join("\n");
}

function buildInvoiceDescription(data, renewal = false) {
  const lines = [
    `Service: ${data.service || data.serviceName || data.serverName || "Hosting"}`,
    `RAM: ${data.ram || "N/A"}`,
    `Disk: ${data.disk || "N/A"}`,
    `CPU: ${data.cpu || "N/A"}`,
    `Location: ${data.location || "N/A"}`,
    `Billing: ${data.billingCycle || data.billingPeriod || "N/A"}`,
    `Price: ${formatMoney(data.price ?? data.total ?? 0, currencyOf(data))}`
  ];
  if (renewal) lines.push(`Renewal of order: ${data.sourceOrderNumber || data.renewalOfOrderNumber || "N/A"}`);
  if (data.discountCode) lines.push(`Discount Code: ${data.discountCode}`);
  return lines.join("\n");
}

/* ============================================================
   CUSTOMER PROFILE + DISCOUNT PROMPTS
============================================================ */
async function getSavedCustomerEmail(discordUserId) {
  const db = initFirebase();
  const snap = await db.ref(`customerProfiles/${discordUserId}`).once("value");
  const profile = snap.val() || {};
  const saved = String(profile.email || profile.customerEmail || "").trim();
  if (saved) return saved;
  // Migrate customers from older bot versions by reusing an email already on an order.
  const ordersSnap = await db.ref("orders").once("value");
  const orders = Object.values(ordersSnap.val() || {}).filter(order => order?.discordUserId === String(discordUserId) && /^\S+@\S+\.\S+$/.test(String(order.customer?.email || "")));
  orders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const legacyEmail = String(orders[0]?.customer?.email || "").trim().toLowerCase();
  if (legacyEmail) await saveCustomerEmail(discordUserId, legacyEmail, orders[0]?.discordUsername || "");
  return legacyEmail;
}

async function saveCustomerEmail(discordUserId, email, username = "") {
  await initFirebase().ref(`customerProfiles/${discordUserId}`).update({
    discordUserId: String(discordUserId),
    email: String(email).trim().toLowerCase(),
    username,
    emailSavedAt: new Date().toISOString()
  });
}

function buildDiscountPrompt(kind, id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${kind}_discount_yes:${id}`).setLabel("Yes, enter a code").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${kind}_discount_no:${id}`).setLabel("No, continue").setStyle(ButtonStyle.Secondary)
  );
}

function buildDiscountCodeModal(kind, id) {
  const modal = new ModalBuilder().setCustomId(`${kind}_discount_code:${id}`).setTitle("Apply discount code");
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId("code").setLabel("Discount code").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(2).setMaxLength(50).setPlaceholder("Enter your code")
  ));
  return modal;
}

function buildRenewServiceRows(renewal) {
  return (renewal.candidates || []).slice(0, 5).map((service, i) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`renew_service:${renewal.renewalId}:${service.orderNumber}`).setLabel(`${i + 1} • ${String(service.serviceName || "Service").slice(0, 65)}`).setStyle(ButtonStyle.Primary)
  ));
}

async function showBuyPaymentPanel(client, orderId, userId) {
  const order = await getOrder(orderId);
  const user = await client.users.fetch(userId);
  const embed = new EmbedBuilder().setTitle("💳 Aura Cloud Payment")
    .setDescription("Choose your payment method below. A discount, if valid, has already been applied to the total.")
    .addFields(
      { name: "Order", value: `\`${order.orderNumber}\``, inline: true },
      { name: "Billing", value: order.billingCycle === "yearly" ? "Yearly" : "Monthly", inline: true },
      { name: "Total", value: formatMoney(order.total ?? order.price, currencyOf(order)), inline: true },
      { name: "Discount", value: order.discountCode ? `${order.discountCode} — ${formatMoney(order.discount, currencyOf(order))} off` : "None", inline: true },
      { name: "Specifications", value: specsText(order) }
    ).setTimestamp();
  await user.send({ embeds: [embed], components: [buildPaymentButtons(orderId)] });
}

async function showRenewServiceSelection(interaction, renewal, useUpdate = false) {
  const payload = { embeds: [new EmbedBuilder().setTitle("🔄 Select the service to renew")
    .setDescription("Choose one confirmed service. Any discount code you entered will be checked against this service's renewal price.")
    .addFields((renewal.candidates || []).slice(0, 5).map((s, i) => ({ name: `${i + 1}. ${s.serviceName}`, value: `${s.ram} RAM • ${s.disk} Disk • ${s.cpu} CPU • ${s.location}`, inline: false }))).setTimestamp()], components: buildRenewServiceRows(renewal) };
  if (useUpdate) await interaction.update(payload); else await interaction.editReply(payload);
}

/* ============================================================
   CUSTOMER CONTINUE BUTTON
============================================================ */

function buildBuyButton(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `buy_start:${orderId}`
        )
        .setLabel("Continue order")
        .setStyle(ButtonStyle.Primary)
    );
}

/* ============================================================
   BUY OTP BUTTON
============================================================ */

function buildOtpButton(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `buy_otp:${orderId}`
        )
        .setLabel("Enter OTP")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   RENEWAL OTP BUTTON
============================================================ */

function buildRenewOtpButton(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_otp:${renewalId}`
        )
        .setLabel("Enter OTP")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   BUY PAYMENT BUTTONS
============================================================ */

function buildPaymentButtons(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`buy_pay:${orderId}:other`)
        .setLabel(PAYMENTS.other.label)
        .setEmoji(PAYMENTS.other.emoji)
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`buy_pay:${orderId}:bank`)
        .setLabel(PAYMENTS.bank.label)
        .setEmoji(PAYMENTS.bank.emoji)
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(`buy_pay:${orderId}:ezcash`)
        .setLabel(PAYMENTS.ezcash.label)
        .setEmoji(PAYMENTS.ezcash.emoji)
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   RENEWAL PAYMENT BUTTONS
============================================================ */

function buildRenewPaymentButtons(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`renew_pay:${renewalId}:other`)
        .setLabel(PAYMENTS.other.label)
        .setEmoji(PAYMENTS.other.emoji)
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`renew_pay:${renewalId}:bank`)
        .setLabel(PAYMENTS.bank.label)
        .setEmoji(PAYMENTS.bank.emoji)
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(`renew_pay:${renewalId}:ezcash`)
        .setLabel(PAYMENTS.ezcash.label)
        .setEmoji(PAYMENTS.ezcash.emoji)
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   PAY BILL BUTTON
============================================================ */

function buildRenewPayBillButton(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_paybill:${renewalId}`
        )
        .setLabel("Pay Bill")
        .setEmoji("💳")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   ADMIN VERIFY BUTTON
============================================================ */

function buildAdminVerifyButton(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `order_verify:${orderId}`
        )
        .setLabel("Verify payment")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   ADMIN REJECT BUTTON
============================================================ */

function buildAdminRejectButton(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `order_reject:${orderId}`
        )
        .setLabel("Reject / needs checking")
        .setEmoji("⚠️")
        .setStyle(ButtonStyle.Danger)
    );
}

/* ============================================================
   ADMIN RENEWAL VERIFY BUTTON
============================================================ */

function buildRenewAdminVerifyButton(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_verify:${renewalId}`
        )
        .setLabel("Verify renewal payment")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   ADMIN RENEWAL REJECT BUTTON
============================================================ */

function buildRenewAdminRejectButton(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_reject:${renewalId}`
        )
        .setLabel("Reject / needs checking")
        .setEmoji("⚠️")
        .setStyle(ButtonStyle.Danger)
    );
}

async function sendCustomerPaymentPanel(client, userId, kind, id) {
  const user = await client.users.fetch(userId);
  const isRenewal = kind === "renew";
  const embed = new EmbedBuilder()
    .setTitle("💳 Choose a payment method")
    .setDescription(
      "Choose a payment method below. PayPal and card payments open a secure PayPal-hosted checkout and are verified automatically after successful payment. Bank transfer and eZ Cash require a receipt upload for admin verification."
    )
    .setTimestamp();
  await user.send({
    embeds: [embed],
    components: [isRenewal ? buildRenewPaymentButtons(id) : buildPaymentButtons(id)]
  });
}

async function sendReceiptToVerification(client, record, receiptUrls, kind) {
  const channel = await client.channels.fetch(ADMIN_VERIFICATION_CHANNEL_ID);
  if (!channel?.isTextBased()) throw new Error("Verification channel is unavailable.");
  const files = receiptUrls.map((item, i) => {
    const url = typeof item === "string" ? item : item.url;
    const filename = typeof item === "string" ? `receipt-${record.orderNumber || record.renewalId}-${i + 1}` : (item.name || `receipt-${record.orderNumber || record.renewalId}-${i + 1}`);
    return { attachment: url, name: filename };
  });
  if (kind === "buy") {
    await sendAdminVerificationAlert(client, record, files);
  } else {
    await sendRenewalVerificationAlert(client, record, files);
  }
}

function receiptPresentation(receiptFiles = []) {
  const imageFile = receiptFiles.find(f => {
    const name = String(f.name || '').toLowerCase();
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
  });
  const imageUrl = imageFile ? String(imageFile.attachment) : null;
  const nonImageFiles = receiptFiles.filter(f => f !== imageFile);
  return { imageUrl, nonImageFiles };
}

/* ============================================================
   SEND ADMIN VERIFICATION ALERT - BUY
============================================================ */

async function sendAdminVerificationAlert(
  client,
  order,
  receiptFiles = []
) {
  const channel =
    await client.channels.fetch(
      ADMIN_VERIFICATION_CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      `Admin verification channel ${ADMIN_VERIFICATION_CHANNEL_ID} could not be opened.`
    );
  }

  const roleMentions =
    ADMIN_VERIFICATION_ROLE_IDS
      .map(id => `<@&${id}>`)
      .join(" ");

  const currency = currencyOf(order);

  const total = money(
    order.total ??
      (
        money(order.price) -
        money(order.discount)
      )
  );

  const embed =
    new EmbedBuilder()
      .setTitle(
        "Payment verification required"
      )
      .setDescription(
        "A customer has completed the order process and uploaded a payment receipt.\n\n" +
        "Check the receipt and payment before clicking **Verify payment**."
      )
      .addFields(
        {
          name: "Order number",
          value: `\`${order.orderNumber}\``,
          inline: true
        },
        {
          name: "Discord customer",
          value: `<@${order.discordUserId}>`,
          inline: true
        },
        {
          name: "Discord username",
          value:
            order.discordUsername ||
            "Unknown",
          inline: true
        },
        {
          name: "Customer name",
          value:
            order.customer?.name ||
            "Not provided",
          inline: true
        },
        {
          name: "Email",
          value:
            order.customer?.email ||
            "Missing",
          inline: true
        },
        {
          name: "Service",
          value:
            order.service ||
            order.serviceName ||
            order.serverName ||
            "Not specified",
          inline: true
        },
        {
          name: "Currency",
          value: currency,
          inline: true
        },
        {
          name: "Payment method",
          value:
            order.paymentMethod ||
            "Not selected",
          inline: true
        },
        {
          name: "Amount to verify",
          value:
            formatMoney(total, currency),
          inline: true
        },
        {
          name: "Specifications",
          value: specsText(order),
          inline: false
        },
        {
          name: "Discount",
          value:
            order.discountCode
              ? `${order.discountCode} — ${formatMoney(
                  order.discount,
                  currency
                )} off`
              : "None",
          inline: true
        },
        {
          name: "How to verify",
          value:
            "1. Check the uploaded receipt.\n" +
            "2. Confirm the amount and order number match.\n" +
            "3. Click **Verify payment** if correct.\n" +
            "4. The bot will generate the invoice and save accounting records.\n" +
            "5. Click **Reject** if the payment is not correct.",
          inline: false
        }
      );

  const receiptView = receiptPresentation(receiptFiles);
  if (receiptView.imageUrl) embed.setImage(receiptView.imageUrl);
  if (!receiptView.imageUrl && receiptFiles.length) {
    embed.setFooter({ text: `Receipt attached • ${receiptFiles.length} file(s)` });
  }

  const sent =
    await channel.send({
      content: roleMentions,
      embeds: [embed],
      files: receiptView.nonImageFiles,
      components: [
        buildAdminVerifyButton(order.orderNumber),
        buildAdminRejectButton(order.orderNumber)
      ]
    });

  await updateOrder(
    order.orderNumber,
    {
      adminVerificationChannelId:
        ADMIN_VERIFICATION_CHANNEL_ID,

      adminVerificationMessageId:
        sent.id,

      adminAlertSentAt:
        new Date().toISOString(),

      status:
        "awaiting_admin_verification"
    }
  );

  return sent;
}

/* ============================================================
   SEND ADMIN VERIFICATION ALERT - RENEWAL
============================================================ */

async function sendRenewalVerificationAlert(
  client,
  renewal,
  receiptFiles = []
) {
  const channel =
    await client.channels.fetch(
      ADMIN_VERIFICATION_CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      "Renewal verification channel could not be opened."
    );
  }

  const roleMentions =
    ADMIN_VERIFICATION_ROLE_IDS
      .map(id => `<@&${id}>`)
      .join(" ");

  const currency =
    currencyOf(renewal);

  const embed =
    new EmbedBuilder()
      .setTitle(
        "🔄 Renewal payment verification required"
      )
      .setDescription(
        "A customer has requested a server renewal and uploaded a payment receipt.\n\n" +
        "Check the receipt and payment before verifying the renewal."
      )
      .addFields(
        {
          name: "Renewal ID",
          value: `\`${renewal.renewalId}\``,
          inline: false
        },
        {
          name: "Previous order",
          value: `\`${renewal.orderNumber}\``,
          inline: true
        },
        {
          name: "Customer",
          value:
            `<@${renewal.discordUserId}>`,
          inline: true
        },
        {
          name: "Username",
          value:
            renewal.discordUsername ||
            "Unknown",
          inline: true
        },
        {
          name: "Email",
          value:
            renewal.customer?.email ||
            "Missing",
          inline: true
        },
        {
          name: "Currency",
          value: currency,
          inline: true
        },
        {
          name: "Amount",
          value:
            formatMoney(
              renewal.total,
              currency
            ),
          inline: true
        },
        {
          name: "Payment method",
          value:
            renewal.paymentMethod ||
            "Unknown",
          inline: true
        },
        {
          name: "Server",
          value:
            getServerName(renewal),
          inline: true
        },
        {
          name: "Specifications",
          value:
            specsText(renewal),
          inline: false
        },
        {
          name: "Current expiry",
          value:
            renewal.previousExpiryDate ||
            "Not recorded",
          inline: true
        },
        {
          name: "Verification",
          value:
            "Check the uploaded receipt. If the payment is correct, click **Verify renewal payment**.",
          inline: false
        }
      );

  const receiptView = receiptPresentation(receiptFiles);
  if (receiptView.imageUrl) embed.setImage(receiptView.imageUrl);
  if (!receiptView.imageUrl && receiptFiles.length) {
    embed.setFooter({ text: `Receipt attached • ${receiptFiles.length} file(s)` });
  }

  const sent =
    await channel.send({
      content: roleMentions,
      embeds: [embed],
      files: receiptView.nonImageFiles,
      components: [
        buildRenewAdminVerifyButton(renewal.renewalId),
        buildRenewAdminRejectButton(renewal.renewalId)
      ]
    });

  await saveRenewalDb(
    renewal.renewalId,
    {
      ...renewal,
      adminVerificationChannelId:
        ADMIN_VERIFICATION_CHANNEL_ID,
      adminVerificationMessageId:
        sent.id,
      adminAlertSentAt:
        new Date().toISOString(),
      status:
        "awaiting_admin_verification"
    }
  );

  return sent;
}

/* ============================================================
   FIND RENEWAL
============================================================ */

async function getRenewal(renewalId) {
  return getRenewalDb(renewalId);
}

/* ============================================================
   SERVICE EXPIRY / NOTIFICATION HELPERS
============================================================ */

function addBillingPeriod(date, billingCycle) {
  const d = new Date(date);
  const billing = String(billingCycle || "monthly").trim().toLowerCase();

  if (billing === "yearly" || billing === "annual" || billing === "annually") {
    d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  d.setMonth(d.getMonth() + 1);
  return d;
}

function calculateInitialServiceExpiry(order, baseDate = new Date()) {
  if (order?.expiryDate && !order?.orderExpiryDate) {
    const existing = new Date(order.expiryDate);
    // Older orders used expiryDate for the 24-hour order TTL. Do not treat that
    // as the customer's hosting expiry after payment is confirmed.
    if (order.status === "confirmed" && !order.serviceStartedAt && !order.billingCycle) {
      return existing.toISOString();
    }
  }

  return addBillingPeriod(baseDate, order?.billingCycle || order?.billingPeriod || "monthly").toISOString();
}

function serviceLabel(order) {
  return order?.serviceName || order?.service || order?.serverName || "Hosting Service";
}

function serviceExpiryDate(order) {
  const raw = order?.currentExpiryDate || order?.serviceExpiryDate || order?.expiryDate;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function isOriginalBuyOrder(order) {
  return !!order &&
    !order.renewalId &&
    !order.sourceOrderNumber &&
    order.orderType !== "renewal" &&
    (order.status === "confirmed" || order.status === "expired" || order.paymentVerified === true);
}

export async function checkServiceExpirations(client) {
  const db = initFirebase();
  const snap = await db.ref("orders").once("value");
  const orders = Object.values(snap.val() || {});
  const now = Date.now();
  const reminderWindow = 24 * 60 * 60 * 1000;
  const channelId = process.env.RENEWAL_LOG_CHANNEL_ID || "1457966756206477375";

  for (const order of orders) {
    if (!isOriginalBuyOrder(order)) continue;

    const expiry = serviceExpiryDate(order);
    if (!expiry) continue;

    const expiryMs = expiry.getTime();
    const isExpired = expiryMs <= now;
    const isAboutToExpire = !isExpired && expiryMs - now <= reminderWindow;

    try {
      if (isAboutToExpire && !order.expiryReminder24hSentAt) {
        const name = serviceLabel(order);
        const expiryText = expiry.toLocaleString();
        const message =
          `⏰ **Service expiring soon**\n\n` +
          `Your **${name}** service is scheduled to expire within 24 hours.\n` +
          `Specifications: ${order.ram || "-"} RAM / ${order.disk || "-"} Disk / ${order.cpu || "-"}\n` +
          `Location: ${order.location || "-"}\n` +
          `Expiry: **${expiryText}**\n\n` +
          `Use **/renew** to renew this service before it expires.`;

        try {
          const user = await client.users.fetch(order.discordUserId);
          await user.send(message);
        } catch (e) {
          console.error(`Could not DM expiry reminder for order ${order.orderNumber}:`, e);
        }

        if (order.customer?.email) {
          try {
            await sendMessageEmail(
              order.customer.email,
              `Aura Cloud Hosting - ${name} expires soon\n\n` +
              `Your service is scheduled to expire within 24 hours.\n\n` +
              `Service: ${name}\n` +
              `RAM: ${order.ram || "-"}\n` +
              `Disk: ${order.disk || "-"}\n` +
              `CPU: ${order.cpu || "-"}\n` +
              `Location: ${order.location || "-"}\n` +
              `Expiry: ${expiryText}\n\n` +
              `Please use /renew in Discord to renew your service.`
            );
          } catch (e) {
            console.error(`Could not email expiry reminder for order ${order.orderNumber}:`, e);
          }
        }

        await updateOrder(order.orderNumber, {
          expiryReminder24hSentAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }

      if (isExpired && !order.expiredNotifiedAt) {
        const name = serviceLabel(order);
        const expiryText = expiry.toLocaleString();
        const userMessage =
          `⚠️ **Service expired**\n\n` +
          `Your **${name}** service has expired.\n` +
          `Specifications: ${order.ram || "-"} RAM / ${order.disk || "-"} Disk / ${order.cpu || "-"}\n` +
          `Location: ${order.location || "-"}\n` +
          `Expired: **${expiryText}**\n\n` +
          `If you want to continue the service, use **/renew**.`;

        try {
          const user = await client.users.fetch(order.discordUserId);
          await user.send(userMessage);
        } catch (e) {
          console.error(`Could not DM expiry notice for order ${order.orderNumber}:`, e);
        }

        if (order.customer?.email) {
          try {
            await sendMessageEmail(
              order.customer.email,
              `Aura Cloud Hosting - ${name} has expired\n\n` +
              `Your hosting service has expired.\n\n` +
              `Service: ${name}\n` +
              `RAM: ${order.ram || "-"}\n` +
              `Disk: ${order.disk || "-"}\n` +
              `CPU: ${order.cpu || "-"}\n` +
              `Location: ${order.location || "-"}\n` +
              `Expired: ${expiryText}\n\n` +
              `If you want to continue the service, use /renew in Discord.`
            );
          } catch (e) {
            console.error(`Could not email expiry notice for order ${order.orderNumber}:`, e);
          }
        }

        try {
          const channel = await client.channels.fetch(channelId);
          if (channel?.isTextBased()) {
            await channel.send({
              embeds: [new EmbedBuilder()
                .setTitle("⚠️ Service expired")
                .setDescription(`A customer service has expired and the customer was notified.`)
                .addFields(
                  { name: "Customer", value: `<@${order.discordUserId}>`, inline: true },
                  { name: "Service", value: name, inline: true },
                  { name: "Order", value: `\`${order.orderNumber}\``, inline: true },
                  { name: "Specifications", value: specsText(order), inline: false },
                  { name: "Location", value: order.location || "Not specified", inline: true },
                  { name: "Expired", value: expiryText, inline: true }
                )
                .setTimestamp()]
            });
          }
        } catch (e) {
          console.error(`Could not send expiry notice to channel ${channelId}:`, e);
        }

        await updateOrder(order.orderNumber, {
          status: "expired",
          accountStatus: "expired",
          serviceStatus: "expired",
          expiredNotifiedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    } catch (e) {
      console.error(`Service expiry check failed for order ${order.orderNumber}:`, e);
    }
  }
}

/* ============================================================
   RENEWAL EXPIRY CALCULATOR
============================================================ */

function calculateRenewalExpiry(order, now = new Date()) {
  let baseDate = now;

  const existingExpiry =
    order.currentExpiryDate ||
    order.serviceExpiryDate ||
    order.expiryDate ||
    order.previousExpiryDate;

  if (existingExpiry) {
    const previous =
      new Date(existingExpiry);

    if (
      !Number.isNaN(previous.getTime()) &&
      previous.getTime() > now.getTime()
    ) {
      baseDate = previous;
    }
  }

  const billing =
    String(
      order.billingCycle ||
      order.duration ||
      "30 days"
    )
      .trim()
      .toLowerCase();

  const match =
    billing.match(
      /^(\d+(?:\.\d+)?)\s*(day|days|d|week|weeks|w|month|months|year|years|y)$/
    );

  if (!match) {
    const next =
      new Date(baseDate);

    next.setDate(
      next.getDate() + 30
    );

    return next.toISOString();
  }

  const amount =
    Number(match[1]);

  const unit =
    match[2];

  const next =
    new Date(baseDate);

  if (
    /^(day|days|d)$/.test(unit)
  ) {
    next.setDate(
      next.getDate() + amount
    );
  } else if (
    /^(week|weeks|w)$/.test(unit)
  ) {
    next.setDate(
      next.getDate() +
      amount * 7
    );
  } else if (
    /^(month|months)$/.test(unit)
  ) {
    next.setMonth(
      next.getMonth() + amount
    );
  } else if (
    /^(year|years|y)$/.test(unit)
  ) {
    next.setFullYear(
      next.getFullYear() + amount
    );
  }

  return next.toISOString();
}

/* ============================================================
   PAYPAL HOSTED CHECKOUT (NO CARD DATA IS STORED BY THE BOT)
============================================================ */

let paypalDiscordClient = null;
let paypalCallbackServer = null;

function paypalConfigured() {
  return Boolean(
    String(process.env.PAYPAL_CLIENT_ID || "").trim() &&
    String(process.env.PAYPAL_CLIENT_SECRET || "").trim()
  );
}

function paypalApiBase() {
  return String(process.env.PAYPAL_MODE || "sandbox").toLowerCase() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function isLocalhostUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function paypalReturnBase() {
  const mode = String(process.env.PAYPAL_MODE || "sandbox").trim().toLowerCase();
  const configured = String(process.env.PAYPAL_RETURN_BASE_URL || "").trim();
  // Sandbox can be tested on the same computer without a public domain.
  // For Live payments, PayPal must return to a publicly reachable HTTPS URL.
  const base = (configured || (mode !== "live" ? "http://localhost:3030" : ""))
    .replace(/\/+$/, "");
  if (!base) throw new Error("PAYPAL_RETURN_BASE_URL is required for live payments and must be a public HTTPS URL.");
  if (!base.startsWith("https://") && !(mode !== "live" && isLocalhostUrl(base))) {
    throw new Error("PAYPAL_RETURN_BASE_URL must use HTTPS. HTTP is allowed only for localhost while PAYPAL_MODE=sandbox.");
  }
  return base;
}

function paypalCheckoutBase() {
  // Localhost is for same-computer Sandbox tests only. Public customers need HTTPS.
  const mode = String(process.env.PAYPAL_MODE || "sandbox").trim().toLowerCase();
  const base = String(process.env.PAYPAL_CHECKOUT_BASE_URL || (mode !== "live" ? "http://localhost:3030" : ""))
    .trim().replace(/\/+$/, "");
  if (!base) throw new Error("Set PAYPAL_CHECKOUT_BASE_URL to your public HTTPS checkout URL for live payments.");
  if (!base.startsWith("https://") && !(mode !== "live" && isLocalhostUrl(base))) {
    throw new Error("PAYPAL_CHECKOUT_BASE_URL must use HTTPS. Localhost HTTP is allowed only for Sandbox testing.");
  }
  return base;
}

function checkoutTokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function checkoutPageUrl(kind, recordKey, token) {
  const url = new URL("/checkout", paypalCheckoutBase());
  url.searchParams.set("kind", kind);
  url.searchParams.set("order", String(recordKey));
  url.searchParams.set("token", token);
  return url.toString();
}

let cachedUsdLkrRate = null;
let cachedUsdLkrAt = 0;
async function getUsdLkrRate() {
  // Cache the rate for six hours to avoid repeatedly calling exchange-rate providers.
  if (cachedUsdLkrRate && Date.now() - cachedUsdLkrAt < 6 * 60 * 60 * 1000) {
    return cachedUsdLkrRate;
  }

  const key = String(process.env.EXCHANGERATE_API_KEY || "").trim();
  const providers = [];

  // Prefer the configured ExchangeRate-API when a key is available.
  if (key) {
    providers.push(async () => {
      const response = await fetch(`https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/latest/USD`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json().catch(() => ({}));
      const rate = Number(data?.conversion_rates?.LKR);
      if (!response.ok || data?.result !== "success" || !Number.isFinite(rate) || rate <= 0) {
        throw new Error(data?.['error-type'] || `HTTP ${response.status}`);
      }
      return rate;
    });
  }

  // Fallback provider requires no API key, so checkout isn't blocked just because
  // EXCHANGERATE_API_KEY is absent, expired, or temporarily rate-limited.
  providers.push(async () => {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => ({}));
    const rate = Number(data?.rates?.LKR);
    if (!response.ok || data?.result !== "success" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(data?.['error-type'] || `HTTP ${response.status}`);
    }
    return rate;
  });

  const errors = [];
  for (const provider of providers) {
    try {
      const rate = await provider();
      cachedUsdLkrRate = rate;
      cachedUsdLkrAt = Date.now();
      return rate;
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(`Could not obtain a USD/LKR exchange rate from available providers. ${errors.join("; ")}`);
}

async function convertCurrency(amount, fromCurrency, toCurrency) {
  const amountValue = money(amount);
  const from = String(fromCurrency || "LKR").toUpperCase();
  const to = String(toCurrency || "LKR").toUpperCase();
  if (from === to) return amountValue;
  if (!(["USD", "LKR"].includes(from) && ["USD", "LKR"].includes(to))) {
    throw new Error(`Unsupported currency conversion: ${from} to ${to}.`);
  }
  const usdLkr = await getUsdLkrRate();
  if (from === "USD" && to === "LKR") return amountValue * usdLkr;
  if (from === "LKR" && to === "USD") return amountValue / usdLkr;
  return amountValue;
}

async function paypalUsdAmount(order) {
  const amount = money(order.total ?? (money(order.price) - money(order.discount)));
  return (await convertCurrency(amount, currencyOf(order), "USD")).toFixed(2);
}

async function paypalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured in .env.");
  const response = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`PayPal authentication failed (${response.status}). Check the PayPal API credentials and PAYPAL_MODE.`);
  }
  return data.access_token;
}

async function createPayPalCheckout(order, method, checkoutKind = "buy", recordKey = order.orderNumber) {
  const accessToken = await paypalAccessToken();
  const amount = await paypalUsdAmount(order);
  const returnBase = paypalReturnBase();
  const orderNumber = String(order.orderNumber);
  const returnUrl = `${returnBase}/paypal/return?kind=${encodeURIComponent(checkoutKind)}&order=${encodeURIComponent(recordKey)}`;
  const cancelUrl = `${returnBase}/paypal/cancel?kind=${encodeURIComponent(checkoutKind)}&order=${encodeURIComponent(recordKey)}`;

  const response = await fetch(`${paypalApiBase()}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": `aura-${orderNumber}-${method}-${Date.now()}`
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: orderNumber,
        custom_id: orderNumber,
        invoice_id: `${orderNumber}-${method}-${Date.now()}`.slice(0, 127),
        description: `Aura Cloud Hosting ${order.service || order.serviceName || order.serverName || "hosting"} — ${orderNumber}`.slice(0, 127),
        amount: { currency_code: "USD", value: amount }
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Aura Cloud Hosting",
            landing_page: "GUEST_CHECKOUT",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: returnUrl,
            cancel_url: cancelUrl
          }
        }
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    console.error("PayPal create order failed:", response.status, data);
    throw new Error("PayPal could not create the secure checkout. Check your PayPal account configuration and try again.");
  }
  // PayPal may return "payer-action" for integrations that explicitly set
  // payment_source.paypal, while other responses use the older "approve" rel.
  const links = Array.isArray(data.links) ? data.links : [];
  const checkoutLink = links.find(link => ["approve", "payer-action"].includes(String(link?.rel || "").toLowerCase()));
  const approvalUrl = checkoutLink?.href;
  if (!approvalUrl) {
    console.error("PayPal order was created but no checkout URL was returned. Link relations:", links.map(link => String(link?.rel || "unknown")));
    throw new Error("PayPal created the order but returned no usable checkout link. Check the PayPal response logs.");
  }
  return { id: data.id, approvalUrl, amount, currency: "USD" };
}

async function capturePayPalOrder(paypalOrderId) {
  const accessToken = await paypalAccessToken();
  const response = await fetch(`${paypalApiBase()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: "{}"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && data?.details?.[0]?.issue === "ORDER_ALREADY_CAPTURED") {
    const orderResponse = await fetch(`${paypalApiBase()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const existingOrder = await orderResponse.json().catch(() => ({}));
    if (orderResponse.ok) return existingOrder;
  }
  if (!response.ok) {
    console.error("PayPal capture failed:", response.status, data);
    throw new Error("PayPal could not confirm/capture this payment. Contact Aura Cloud support if you were charged.");
  }
  return data;
}

function captureDetails(data) {
  const unit = data?.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];

  // Only actual capture data can confirm a payment. Never fall back to an
  // order status, authorization amount, or the originally requested amount.
  const amount = capture?.amount;

  return {
    status: capture?.status || "",
    captureId: capture?.id || "",
    currency: amount?.currency_code || "",
    amount: amount?.value || "",
    customId: unit?.custom_id || unit?.reference_id || ""
  };
}

function htmlResponse(title, message) {
  const safeTitle = String(title).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const safeMessage = String(message).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${safeTitle} — Aura Cloud</title><body style="margin:0;background:#080711;color:#f6f3ff;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center"><main style="width:min(620px,calc(100% - 32px));margin:24px;padding:32px;border:1px solid #38304e;border-radius:18px;background:#12101d;box-shadow:0 24px 90px #0008"><div style="color:#a78bfa;font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-size:12px">Aura Cloud Hosting</div><h1>${safeTitle}</h1><p>${safeMessage}</p><p style="color:#b8b2ca">When you're ready, return to Discord to check your order and invoice.</p><a href="https://discord.com/app" style="display:inline-block;margin-top:8px;padding:12px 18px;border-radius:12px;background:linear-gradient(100deg,#8b5cf6,#5b70f4);color:white;text-decoration:none;font-weight:800">Return to Discord</a></main></body></html>`;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Request body must be valid JSON."); }
}

async function getCheckoutRecord(kind, key) {
  if (kind === "buy") return await getOrder(key);
  if (kind === "renewal") return await getRenewal(key);
  throw new Error("Invalid checkout type.");
}

async function updateCheckoutRecord(kind, key, current, patch) {
  if (kind === "buy") return await updateOrder(key, patch);
  if (kind === "renewal") return await updateRenewalDb(key, { ...current, ...patch });
  throw new Error("Invalid checkout type.");
}

function validateCheckoutSession(record, token) {
  if (!record || !token) return false;
  // checkoutToken supports checkout links created by the previous localhost build.
  if (record.checkoutToken && record.checkoutToken === token) {
    return !record.checkoutExpiresAt || Date.parse(record.checkoutExpiresAt) > Date.now();
  }
  if (!record.checkoutTokenHash) return false;
  const expected = Buffer.from(String(record.checkoutTokenHash), "hex");
  const actual = Buffer.from(checkoutTokenHash(token), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) &&
    (!record.checkoutExpiresAt || Date.parse(record.checkoutExpiresAt) > Date.now());
}

async function loadCheckoutSession(kind, key, token) {
  if (!key || !token) throw new Error("This checkout link is incomplete. Start a new checkout in Discord.");
  const record = await getCheckoutRecord(kind, key);
  if (!validateCheckoutSession(record, token)) throw new Error("This checkout link is invalid or expired. Return to Discord and start a new checkout.");
  if (!["paypal", "card", "other"].includes(record.paymentMethodKey)) throw new Error("This order is not configured for the hosted payment page.");
  if (record.status === "confirmed" || (kind === "buy" && record.paymentVerified === true)) throw new Error("This order has already been paid and confirmed.");
  if (record.status !== "payment_selected") throw new Error("This order is not waiting for payment.");
  return record;
}

async function restoreDiscordPaymentPanel(kind, key, record) {
  if (!paypalDiscordClient) throw new Error("Discord bot is not connected. Please try again from Discord.");

  const isRenewal = kind === "renewal";
  const embed = new EmbedBuilder()
    .setTitle(isRenewal ? "🔄 Aura Cloud Renewal Payment" : "💳 Aura Cloud Payment")
    .setDescription("Choose a payment method below. Your previous checkout was cancelled; no payment was confirmed by Aura Cloud.")
    .addFields(
      { name: isRenewal ? "Renewal" : "Order", value: "`" + String(key) + "`", inline: true },
      { name: "Billing", value: /year|annual/i.test(String(record.billingCycle || record.billingPeriod || "")) ? "Yearly" : "Monthly", inline: true },
      { name: "Total", value: formatMoney(record.total ?? record.price ?? 0, currencyOf(record)), inline: true },
      ...(!isRenewal ? [{ name: "Discount", value: record.discountCode ? String(record.discountCode) + " — " + formatMoney(record.discount || 0, currencyOf(record)) + " off" : "None", inline: true }] : []),
      { name: "Specifications", value: specsText(record) }
    )
    .setTimestamp();

  const payload = {
    content: null,
    embeds: [embed],
    components: [isRenewal ? buildRenewPaymentButtons(key) : buildPaymentButtons(key)]
  };

  if (record.paymentPanelChannelId && record.paymentPanelMessageId) {
    try {
      const channel = await paypalDiscordClient.channels.fetch(String(record.paymentPanelChannelId));
      const message = channel?.messages ? await channel.messages.fetch(String(record.paymentPanelMessageId)) : null;
      if (message) {
        await message.edit(payload);
        return "existing";
      }
    } catch (error) {
      console.warn("Could not restore the original Discord payment panel; sending a new one instead:", error?.message || error);
    }
  }

  await sendCustomerPaymentPanel(paypalDiscordClient, record.discordUserId, isRenewal ? "renew" : "buy", key);
  return "new";
}

async function cancelWebCheckout(kind, key, token) {
  const record = await loadCheckoutSession(kind, key, token);
  if (record.status === "confirmed" || record.paymentVerified === true || record.paypalCaptureStatus === "COMPLETED") {
    throw new Error("This payment is already confirmed. Do not cancel or pay again.");
  }

  await updateCheckoutRecord(kind, key, record, {
    status: "awaiting_payment",
    paymentMethod: null,
    paymentMethodKey: null,
    checkoutTokenHash: null,
    checkoutToken: null,
    checkoutKind: null,
    checkoutCreatedAt: null,
    checkoutExpiresAt: null,
    paypalOrderId: null,
    paypalAmount: null,
    paypalCurrency: null,
    paypalApprovalUrl: null,
    checkoutUrl: null,
    paypalCreatedAt: null,
    paypalCaptureStatus: null,
    paypalCaptureId: null,
    paypalCapturedAmount: null,
    paypalCapturedCurrency: null,
    paypalCapturedAt: null,
    checkoutCancelledAt: new Date().toISOString()
  });

  const panel = await restoreDiscordPaymentPanel(kind, key, record);
  return {
    cancelled: true,
    panel,
    message: panel === "existing"
      ? "Checkout cancelled. Your Discord payment panel is ready to choose another method."
      : "Checkout cancelled. A new payment selection panel has been sent to your Discord DM.",
    returnUrl: "https://discord.com/channels/@me"
  };
}
async function createCardFieldsOrder(kind, key, token) {
  if (!paypalConfigured()) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.");
  const record = await loadCheckoutSession(kind, key, token);
  if (record.paymentMethodKey !== "card") throw new Error("This checkout was not started as a card payment.");

  const expectedAmount = Number(record.paypalAmount || await paypalUsdAmount(record)).toFixed(2);
  const reference = String(record.orderNumber || record.renewalId || key);
  const accessToken = await paypalAccessToken();
  const response = await fetch(`${paypalApiBase()}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": `aura-card-${reference}-${crypto.randomBytes(8).toString("hex")}`
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: reference,
        custom_id: reference,
        invoice_id: `${reference}-CARD-${Date.now()}`.slice(0, 127),
        description: `Aura Cloud Hosting ${record.service || record.serviceName || record.serverName || "hosting"} — ${reference}`.slice(0, 127),
        amount: { currency_code: "USD", value: expectedAmount }
      }],
      payment_source: {
        card: {
          attributes: {
            verification: {
              method: "SCA_ALWAYS"
            }
          }
        }
      }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    console.error("PayPal Card Fields create-order failed:", response.status, data);
    throw new Error("PayPal could not start card payment. Check that Advanced Credit and Debit Card Payments is enabled for this account.");
  }

  await updateCheckoutRecord(kind, key, record, {
    paypalCardOrderId: data.id,
    paypalAmount: expectedAmount,
    paypalCurrency: "USD",
    paypalCardOrderCreatedAt: new Date().toISOString()
  });
  return { orderID: data.id };
}

async function captureCardFieldsOrder(kind, key, token, paypalOrderID) {
  if (!paypalConfigured()) throw new Error("PayPal is not configured on the server.");
  const record = await loadCheckoutSession(kind, key, token);
  if (record.paymentMethodKey !== "card") throw new Error("This checkout was not started as a card payment.");
  if (!paypalOrderID || String(record.paypalCardOrderId || "") !== String(paypalOrderID)) {
    throw new Error("The PayPal order does not match this checkout. Please start a new checkout.");
  }

  // Verify the issuer's 3-D Secure result from PayPal's server-side order
  // details before capture. The browser's popup closing is not proof of success.
  const accessToken = await paypalAccessToken();
  const verificationResponse = await fetch(
    `${paypalApiBase()}/v2/checkout/orders/${encodeURIComponent(paypalOrderID)}?fields=payment_source`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const verificationOrder = await verificationResponse.json().catch(() => ({}));
  if (!verificationResponse.ok) {
    console.error("PayPal 3-D Secure verification lookup failed:", verificationResponse.status);
    throw new Error("Could not verify the card authentication result with PayPal. No capture was attempted; please try another payment method.");
  }

  const cardAuthentication = verificationOrder?.payment_source?.card?.authentication_result;
  const liabilityShift = String(cardAuthentication?.liability_shift || "").toUpperCase();
  const authenticationStatus = String(cardAuthentication?.three_d_secure?.authentication_status || "").toUpperCase();

  // Only proceed when PayPal reports an acceptable liability shift and the
  // challenge was not failed, rejected, or left incomplete.
  if (!["POSSIBLE", "YES"].includes(liabilityShift) ||
      ["N", "R", "U", "C"].includes(authenticationStatus)) {
    console.warn("Card payment blocked because 3-D Secure was not verified:", {
      liabilityShift: liabilityShift || "MISSING",
      authenticationStatus: authenticationStatus || "MISSING"
    });
    throw new Error("Your card's 3-D Secure authentication could not be verified. Aura Cloud has not captured the payment. Please try another card or payment method.");
  }

  const captured = await capturePayPalOrder(paypalOrderID);
  const details = captureDetails(captured);
  const expectedAmount = Number(record.paypalAmount || await paypalUsdAmount(record)).toFixed(2);
  const expectedReference = String(record.orderNumber || record.renewalId || key);
  const matches = details.status === "COMPLETED" &&
    Boolean(details.captureId) &&
    details.currency === "USD" &&
    Number.isFinite(Number(details.amount)) &&
    Number(details.amount).toFixed(2) === expectedAmount &&
    details.customId === expectedReference;

  if (!matches) {
    await updateCheckoutRecord(kind, key, record, {
      paypalCaptureStatus: details.status || "NOT_COMPLETED",
      paypalCaptureCheckedAt: new Date().toISOString()
    });
    throw new Error("PayPal did not return a completed payment matching this order, amount, and currency. The order has not been marked paid.");
  }

  const capture = captured?.purchase_units?.[0]?.payments?.captures?.[0];
  await updateCheckoutRecord(kind, key, record, {
    paypalCaptureStatus: "COMPLETED",
    paypalCaptureId: capture?.id || null,
    paypalCapturedAmount: details.amount,
    paypalCapturedCurrency: details.currency,
    paypalCapturedAt: new Date().toISOString(),
    status: "payment_selected"
  });

  const systemUser = { id: "paypal-card-system", username: "PayPal card automatic verification", tag: "PayPal card automatic verification" };
  if (kind === "buy") {
    await finalizeOrder(record.orderNumber, systemUser, null, paypalDiscordClient);
  } else {
    await finalizeRenewal(key, systemUser, paypalDiscordClient);
  }

  return {
    paid: true,
    message: "Payment verified successfully. Aura Cloud has confirmed your order and sent the invoice to your Discord DM.",
    returnUrl: "https://discord.com/channels/@me"
  };
}

export function startPayPalCallbackServer(client) {
  paypalDiscordClient = client;
  if (paypalCallbackServer) return;
  const port = Number(process.env.PAYPAL_CALLBACK_PORT || 3030);

  paypalCallbackServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/checkout")) {
        const page = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "Aura Cloud payment service" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/checkout") {
        const kind = String(url.searchParams.get("kind") || "buy");
        const key = String(url.searchParams.get("order") || "");
        const token = String(url.searchParams.get("token") || "");
        const record = await loadCheckoutSession(kind, key, token);
        sendJson(res, 200, {
          orderNumber: String(record.orderNumber || record.renewalId || key),
          service: String(record.service || record.serviceName || record.serverName || "Aura Cloud Hosting Service"),
          billingCycle: String(record.billingCycle || record.billingPeriod || "monthly"),
          paymentMethod: String(record.paymentMethod || (record.paymentMethodKey === "other" ? "Other Payment" : record.paymentMethodKey === "card" ? "Card Payment" : "PayPal")),
          paymentMethodKey: record.paymentMethodKey,
          hostedPayPalUrl: record.paymentMethodKey === "other" ? PAYPAL_HOSTED_PAYMENT_URL : null,
          currency: currencyOf(record),
          price: money(record.price),
          discount: money(record.discount),
          total: money(record.total ?? (money(record.price) - money(record.discount))),
          paypalAmount: String(record.paypalAmount || ""),
          paypalCurrency: String(record.paypalCurrency || "USD"),
          ram: String(record.ram || "Not specified"),
          disk: String(record.disk || "Not specified"),
          cpu: String(record.cpu || "Not specified"),
          location: String(record.location || "Not specified"),
          bandwidth: String(record.bandwidth || "Not specified"),
          billingDescription: String(record.billingDescription || ""),
          checkoutUrl: String(record.paypalApprovalUrl || record.checkoutUrl || ""),
          paypalClientId: process.env.PAYPAL_CLIENT_ID || null
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/checkout/cancel") {
        const body = await readJsonBody(req);
        const kind = String(body.kind || "buy");
        const key = String(body.order || "");
        const token = String(body.token || "");
        sendJson(res, 200, await cancelWebCheckout(kind, key, token));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/paypal/create-order") {
        const body = await readJsonBody(req);
        sendJson(res, 200, await createCardFieldsOrder(String(body.kind || "buy"), String(body.order || ""), String(body.token || "")));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/paypal/capture-order") {
        const body = await readJsonBody(req);
        sendJson(res, 200, await captureCardFieldsOrder(String(body.kind || "buy"), String(body.order || ""), String(body.token || ""), String(body.paypalOrderID || "")));
        return;
      }

      if (url.pathname === "/paypal/cancel") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlResponse("Payment cancelled", "No payment was confirmed. Return to your Aura Cloud checkout page or Discord to try again."));
        return;
      }

      if (req.method === "GET" && url.pathname === "/paypal/return") {
        const kind = String(url.searchParams.get("kind") || "buy");
        const key = String(url.searchParams.get("order") || "");
        const paypalOrderId = String(url.searchParams.get("token") || "");
        if (!key || !paypalOrderId || !["buy", "renewal"].includes(kind)) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlResponse("Payment not confirmed", "The return information was incomplete. Contact Aura Cloud support before trying again."));
          return;
        }

        const record = await getCheckoutRecord(kind, key);
        if (!record || record.paypalOrderId !== paypalOrderId || !["paypal", "card"].includes(record.paymentMethodKey)) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlResponse("Payment not confirmed", "This PayPal checkout does not match an active Aura Cloud order."));
          return;
        }
        if (record.status === "confirmed" && record.paypalCaptureStatus === "COMPLETED") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlResponse("Payment already confirmed", "Your payment was already confirmed. Your invoice was sent to your Discord DM."));
          return;
        }

        const captured = await capturePayPalOrder(paypalOrderId);
        const details = captureDetails(captured);
        const expectedUsd = Number(record.paypalAmount || await paypalUsdAmount(record)).toFixed(2);
        const expectedReference = String(record.orderNumber || record.renewalId || key);
        const matches = details.status === "COMPLETED" &&
          Boolean(details.captureId) &&
          details.currency === "USD" &&
          Number.isFinite(Number(details.amount)) &&
          Number(details.amount).toFixed(2) === expectedUsd &&
          details.customId === expectedReference;
        if (!matches) {
          await updateCheckoutRecord(kind, key, record, { paypalCaptureStatus: details.status || "NOT_COMPLETED", paypalCaptureCheckedAt: new Date().toISOString() });
          res.writeHead(402, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlResponse("Payment not confirmed", "PayPal did not return a completed payment matching this order. Aura Cloud has not marked it paid."));
          return;
        }

        const capture = captured?.purchase_units?.[0]?.payments?.captures?.[0];
        await updateCheckoutRecord(kind, key, record, {
          paypalCaptureStatus: "COMPLETED",
          paypalCaptureId: capture?.id || null,
          paypalCapturedAmount: details.amount,
          paypalCapturedCurrency: details.currency,
          paypalCapturedAt: new Date().toISOString(),
          status: "payment_selected"
        });
        const systemUser = { id: "paypal-system", username: "PayPal automatic verification", tag: "PayPal automatic verification" };
        if (kind === "buy") await finalizeOrder(record.orderNumber, systemUser, null, paypalDiscordClient);
        else await finalizeRenewal(key, systemUser, paypalDiscordClient);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlResponse("Payment successful", "PayPal confirmed your payment. Aura Cloud has verified your order and sent your invoice to your Discord DM."));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlResponse("Not found", "This payment page was not found."));
    } catch (error) {
      console.error("PayPal checkout server request failed:", error);
      if (url.pathname.startsWith("/api/")) sendJson(res, 400, { error: error.message || "Checkout request failed." });
      else {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlResponse("Checkout needs attention", error.message || "We could not complete this request. Contact Aura Cloud support."));
      }
    }
  });

  paypalCallbackServer.on("error", error => console.error("PayPal callback server error:", error));
  paypalCallbackServer.listen(port, "0.0.0.0", () => console.log(`PayPal checkout website and callback server listening on port ${port}`));
}

/* ============================================================
   DELIVERY CHANNEL TASK / ADMIN REACTION
============================================================ */

async function postDeliveryTask(client, order, invoice) {
  if (!client || order.deliveryMessageId) return;
  const channelId = process.env.ORDER_DELIVERY_CHANNEL_ID || "1457966756206477375";
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error(`Order delivery channel ${channelId} is unavailable.`);
  const adminRoleId = process.env.BUY_ADMIN_ROLE_ID || "1556314578273706076";
  const content = [
    `<@&${adminRoleId}>`,
    `🛠️ **NEW PAID ORDER — PLEASE PROVISION THIS SERVICE**`,
    `**Order:** \`${order.orderNumber}\``,
    `**Customer:** <@${order.discordUserId}>`,
    `**Service:** ${order.service || order.serviceName || order.serverName || "Hosting"}`,
    `**RAM:** ${order.ram || "Not specified"}`,
    `**Disk:** ${order.disk || "Not specified"}`,
    `**CPU:** ${order.cpu || "Not specified"}`,
    `**Location:** ${order.location || "Not specified"}`,
    `**Billing:** ${order.billingCycle || order.billingPeriod || "Monthly"}`,
    `**Paid:** ${formatMoney(invoice.total, invoice.currency)}`,
    `**Invoice:** \`${invoice.invoiceNumber}\``,
    "",
    "React with ✅ after the server/service has been delivered. The bot will edit this same message to mark it as delivered."
  ].join("\n");
  const sent = await channel.send({
    content,
    allowedMentions: { roles: [adminRoleId], users: [order.discordUserId] }
  });
  await sent.react("✅");
  await updateOrder(order.orderNumber, {
    deliveryChannelId: channelId,
    deliveryMessageId: sent.id,
    deliveryStatus: "pending",
    deliveryTaskSentAt: new Date().toISOString()
  });
}

export async function handleDeliveryReaction(reaction, user) {
  try {
    if (user?.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message;
    if (message.partial) await message.fetch();
    if (message.channelId !== (process.env.ORDER_DELIVERY_CHANNEL_ID || "1457966756206477375")) return;
    if (reaction.emoji.name !== "✅") return;

    const db = initFirebase();
    const snapshot = await db.ref("orders").once("value");
    const orders = Object.values(snapshot.val() || {});
    const order = orders.find(item => item?.deliveryMessageId === message.id);
    if (!order || order.deliveryStatus === "delivered") return;

    const guild = message.guild;
    if (!guild) return;
    const member = await guild.members.fetch(user.id);
    const adminRoleId = process.env.BUY_ADMIN_ROLE_ID || "1556314578273706076";
    const authorized = member.roles.cache.has(adminRoleId) ||
      ADMIN_VERIFICATION_ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
    if (!authorized) {
      try { await reaction.users.remove(user.id); } catch {}
      return;
    }

    const markedAt = new Date().toISOString();
    await updateOrder(order.orderNumber, {
      deliveryStatus: "delivered",
      deliveredAt: markedAt,
      deliveredBy: { userId: user.id, username: user.tag || user.username }
    });
    await message.edit({
      content: `✅ **DELIVERED** — marked by <@${user.id}>\n\n${message.content}`,
      allowedMentions: { users: [user.id], roles: [] }
    });
  } catch (error) {
    console.error("Delivery reaction handler failed:", error);
  }
}

/* ============================================================
   FINALIZE / VERIFY ORDER
============================================================ */

async function finalizeOrder(
  orderNumber,
  adminUser,
  sourceInteraction = null,
  client = null
) {
  const current =
    await getOrder(orderNumber);

  if (!current) {
    throw new Error(
      "Order not found."
    );
  }

  if (
    current.status ===
    "confirmed"
  ) {
    return {
      alreadyConfirmed: true,
      order: current,
      invoiceNumber:
        current.invoiceNumber
    };
  }

  if (!current.customer?.email) {
    throw new Error(
      "Customer email is missing."
    );
  }

  if (
    current.status !==
      "payment_selected" &&
    current.status !==
      "awaiting_admin_verification"
  ) {
    throw new Error(
      "This order has not completed email verification and payment selection yet."
    );
  }

  // Order number and invoice number are intentionally identical.
  const invoiceNumber = String(current.orderNumber);

  const totals =
    calculateInvoice({
      quantity: 1,
      unitPrice: money(
        current.price
      ),
      discount: money(
        current.discount
      ),
      tax: 0
    });

  const now =
    new Date().toISOString();

  const invoice = {
    ...current,

    invoiceNumber,

    description: buildInvoiceDescription(current),

    quantity: 1,

    billingCycle:
      current.billingCycle ||
      "",

    unitPrice:
      money(current.price),

    discount:
      money(current.discount),

    tax: 0,

    total:
      totals.total,

    lineTotal:
      totals.lineTotal,

    subtotal:
      totals.subtotal,

    currency:
      currencyOf(current),

    status:
      "Paid",

    paymentStatus: "Paid",

    purchaseDate:
      now.slice(0, 10),

    // The old `expiresAt` field is the short order/payment TTL.
    // `expiryDate` is the actual hosting-service expiry.
    expiryDate:
      calculateInitialServiceExpiry(current, new Date()),

    serviceExpiryDate:
      calculateInitialServiceExpiry(current, new Date()),

    serviceStartedAt:
      now,

    createdAt:
      current.createdAt ||
      now,

    confirmedAt:
      now,

    confirmedBy: {
      userId:
        adminUser.id,
      username:
        adminUser.tag ||
        adminUser.username ||
        "Unknown"
    }
  };

  const {
    xlsxPath,
    pdfPath
  } =
    await createInvoiceFiles(
      invoice
    );

  invoice.xlsxPath =
    xlsxPath;

  invoice.pdfPath =
    pdfPath;

  await saveOrder(
    orderNumber,
    {
      ...current,
      ...invoice,

      status:
        "confirmed",

      paymentVerified:
        true,

      paymentVerifiedAt:
        now,

      paymentVerifiedBy: {
        userId: adminUser.id,
        username: adminUser.tag || adminUser.username || "Unknown",
        method: adminUser.id === "paypal-system" ? "automatic_paypal_capture" : "admin"
      }
    }
  );

  await saveInvoice(
    invoiceNumber,
    invoice
  );

  await addOrder({
    ...invoice,
    orderNumber
  });

  await addInvoice(
    invoice
  );

  await addTransaction({
    id:
      orderNumber,

    type:
      "income",

    amount:
      invoice.total,

    currency:
      invoice.currency,

    description:
      `Payment for ${orderNumber} / ${invoice.invoiceNumber}`,

    service:
      `Hosting - ${current.location}`,

    paymentMethod:
      current.paymentMethod ||
      "Unknown",

    status:
      "paid",

    date:
      invoice.purchaseDate,

    createdAt:
      now
  });

  let emailSent =
    true;

  try {
    await sendInvoiceEmail(
      invoice.customer.email,
      invoice.invoiceNumber,
      pdfPath
    );
  } catch (error) {
    emailSent =
      false;

    console.error(
      "Invoice email failed:",
      error
    );
  }

  /* ==========================================================
     DM INVOICE TO CUSTOMER
  ========================================================== */

  let discordDmSent =
    false;

  try {
    const discordClient =
      client ||
      sourceInteraction?.client;

    if (discordClient) {
      const user =
        await discordClient.users.fetch(
          invoice.discordUserId
        );

      await user.send({
        content:
          `✅ **Payment verified!**\n\n` +
          `Thank you for choosing Aura Cloud Hosting! 🎉\n\n` +
          `Your order **${invoice.orderNumber}** has been confirmed.\n` +
          `Specifications: ${invoice.ram || "-"} RAM • ${invoice.disk || "-"} Disk • ${invoice.cpu || "-"}\n` +
          `Location: **${invoice.location || "-"}**\n` +
          `Price: **${formatMoney(invoice.total, invoice.currency)}**\n\n` +
          `Please wait a little while until your service is processed.\n` +
          `Invoice: **${invoice.invoiceNumber}** is attached below.`,

        files: [
          new AttachmentBuilder(
            pdfPath,
            {
              name:
                `${invoice.invoiceNumber}.pdf`
            }
          )
        ]
      });

      discordDmSent =
        true;
    }
  } catch (error) {
    console.error(
      "Customer invoice DM failed:",
      error
    );
  }

  /* ==========================================================
     PAID ORDER DELIVERY TASK
  ========================================================== */

  try {
    await postDeliveryTask(client || sourceInteraction?.client, {
      ...current,
      ...invoice,
      deliveryMessageId: current.deliveryMessageId
    }, invoice);
  } catch (error) {
    console.error("Could not post paid order delivery task:", error);
  }

  /* ==========================================================
     SEND INVOICE TO VERIFICATION CHANNEL
  ========================================================== */

  try {
    const discordClient = client || sourceInteraction?.client;
    const channel = discordClient ? await discordClient.channels.fetch(ADMIN_VERIFICATION_CHANNEL_ID) : null;
    if (channel?.isTextBased()) {
      await channel.send({
        content: `📄 **Invoice created for confirmed order ${orderNumber}**\nCustomer: <@${invoice.discordUserId}>\nAmount: **${formatMoney(invoice.total, invoice.currency)}**`,
        files: [new AttachmentBuilder(pdfPath, { name: `${invoice.invoiceNumber}.pdf` })]
      });
    }
  } catch (error) {
    console.error("Could not send invoice to verification channel:", error);
  }

  /* ==========================================================
     UPDATE ADMIN MESSAGE
  ========================================================== */

  try {
    if (
      current.adminVerificationChannelId &&
      current.adminVerificationMessageId
    ) {
      const discordClient =
        client ||
        sourceInteraction?.client;

      if (discordClient) {
        const channel =
          await discordClient.channels.fetch(
            current.adminVerificationChannelId
          );

        if (
          channel?.isTextBased()
        ) {
          const alertMessage =
            await channel.messages.fetch(
              current.adminVerificationMessageId
            );

          await alertMessage.edit({
            content:
              `✅ Payment verified by <@${adminUser.id}>`,

            embeds: [
              new EmbedBuilder()
                .setTitle(
                  "Order verified successfully"
                )
                .setDescription(
                  "Payment was verified and the order was completed."
                )
                .addFields(
                  {
                    name: "Order",
                    value:
                      `\`${orderNumber}\``,
                    inline: true
                  },
                  {
                    name: "Invoice",
                    value:
                      `\`${invoice.invoiceNumber}\``,
                    inline: true
                  },
                  {
                    name: "Customer",
                    value:
                      `<@${invoice.discordUserId}>`,
                    inline: true
                  },
                  {
                    name: "Amount",
                    value:
                      formatMoney(
                        invoice.total,
                        invoice.currency
                      ),
                    inline: true
                  },
                  {
                    name: "Payment",
                    value:
                      invoice.paymentMethod ||
                      "Unknown",
                    inline: true
                  },
                  {
                    name: "Invoice email",
                    value:
                      emailSent
                        ? "Sent"
                        : "Failed",
                    inline: true
                  },
                  {
                    name: "Invoice Discord DM",
                    value:
                      discordDmSent
                        ? "Sent"
                        : "Failed",
                    inline: true
                  }
                )
                .setTimestamp()
            ],

            components: []
          });
        }
      }
    }
  } catch (error) {
    console.error(
      "Could not update admin verification message:",
      error
    );
  }

  return {
    alreadyConfirmed: false,
    order: invoice,
    invoiceNumber,
    xlsxPath,
    pdfPath,
    emailSent,
    discordDmSent
  };
}

/* ============================================================
   FINALIZE / VERIFY RENEWAL
============================================================ */

async function finalizeRenewal(
  renewalId,
  adminUser,
  client
) {
  const renewal =
    await getRenewal(
      renewalId
    );

  if (!renewal) {
    throw new Error(
      "Renewal not found."
    );
  }

  if (
    renewal.status ===
      "confirmed" ||
    renewal.paymentVerified ===
      true
  ) {
    return {
      alreadyConfirmed: true,
      renewal,
      invoiceNumber:
        renewal.invoiceNumber
    };
  }

  if (
    renewal.status !==
      "payment_selected" &&
    renewal.status !==
      "awaiting_admin_verification"
  ) {
    throw new Error(
      "This renewal is not waiting for payment verification."
    );
  }

  if (!renewal.customer?.email) {
    throw new Error(
      "Customer email is missing from the original order."
    );
  }

  // Each renewal is its own transaction. It gets a new numeric order number,
  // and its invoice number is exactly the same number.
  const invoiceNumber = String(renewal.orderNumber);

  const currency =
    currencyOf(renewal);

  const totals =
    calculateInvoice({
      quantity: 1,
      unitPrice: money(renewal.price),
      discount: money(renewal.discount),
      tax: 0
    });

  const now =
    new Date().toISOString();

  const newExpiryDate =
    calculateRenewalExpiry(
      renewal.sourceOrder ||
      renewal
    );

  const invoice = {
    ...renewal,

    invoiceNumber,

    orderNumber:
      renewal.orderNumber,

    renewalId,

    renewalOfOrderNumber:
      renewal.orderNumber,

    description: buildInvoiceDescription(renewal, true),

    quantity: 1,

    billingCycle:
      renewal.billingCycle ||
      "30 days",

    unitPrice:
      money(renewal.price),

    discount: money(renewal.discount),

    total: totals.total,

    tax: 0,

    subtotal:
      totals.subtotal,

    lineTotal:
      totals.lineTotal,

    currency,

    status:
      "Paid",

    paymentStatus: "Paid",

    purchaseDate:
      now.slice(0, 10),

    previousExpiryDate:
      renewal.previousExpiryDate ||
      "",

    expiryDate:
      newExpiryDate,

    createdAt:
      renewal.createdAt ||
      now,

    confirmedAt:
      now,

    confirmedBy: {
      userId:
        adminUser.id,

      username:
        adminUser.tag ||
        adminUser.username ||
        "Unknown"
    }
  };

  const {
    xlsxPath,
    pdfPath
  } =
    await createInvoiceFiles(
      invoice
    );

  invoice.xlsxPath =
    xlsxPath;

  invoice.pdfPath =
    pdfPath;

  /* ==========================================================
     SAVE RENEWAL
  ========================================================== */

  await saveRenewalDb(
    renewalId,
    {
      ...renewal,
      ...invoice,

      status:
        "confirmed",

      paymentVerified:
        true,

      paymentVerifiedAt:
        now,

      paymentVerifiedBy: {
        userId:
          adminUser.id,

        username:
          adminUser.tag ||
          adminUser.username ||
          "Unknown"
      }
    }
  );

  /* ==========================================================
     SAVE INVOICE
  ========================================================== */

  await saveInvoice(
    invoiceNumber,
    invoice
  );

  /* ==========================================================
     UPDATE ORIGINAL ACCOUNT / ORDER AS PAID
  ========================================================== */

  const originalOrder =
    await getOrder(
      renewal.sourceOrderNumber || renewal.orderNumber
    );

  if (originalOrder) {
    await updateOrder(
      renewal.sourceOrderNumber,
      {
        accountStatus:
          "paid",

        paymentStatus:
          "paid",

        lastPaymentStatus:
          "paid",

        lastPaymentDate:
          now,

        lastRenewalId:
          renewalId,

        lastRenewalInvoiceNumber:
          invoiceNumber,

        lastRenewalAmount:
          invoice.total,

        lastRenewalCurrency:
          currency,

        renewedAt:
          now,

        expiryDate:
          newExpiryDate,

        serviceExpiryDate:
          newExpiryDate,

        currentExpiryDate:
          newExpiryDate,

        status:
          "confirmed",

        serviceStatus:
          "active",

        accountStatus:
          "paid",

        updatedAt:
          now
      }
    );
  }

  /* ==========================================================
     GOOGLE SHEETS - RENEWAL ORDER
  ========================================================== */

  await addOrder({
    ...invoice,

    orderNumber:
      renewal.orderNumber,

    renewalId,

    orderType:
      "renewal"
  });

  /* ==========================================================
     GOOGLE SHEETS - INVOICE
  ========================================================== */

  await addInvoice(
    invoice
  );

  /* ==========================================================
     GOOGLE SHEETS - TRANSACTION
  ========================================================== */

  await addTransaction({
    id:
      renewalId,

    type:
      "income",

    amount:
      invoice.total,

    currency,

    description:
      `Renewal payment for ${renewal.orderNumber} / ${invoice.invoiceNumber}`,

    service:
      `Hosting Renewal - ${renewal.location}`,

    paymentMethod:
      renewal.paymentMethod ||
      "Unknown",

    status:
      "paid",

    date:
      invoice.purchaseDate,

    createdAt:
      now
  });

  /* ==========================================================
     EMAIL INVOICE
  ========================================================== */

  let emailSent =
    true;

  try {
    await sendInvoiceEmail(
      invoice.customer.email,
      invoice.invoiceNumber,
      pdfPath
    );
  } catch (error) {
    emailSent =
      false;

    console.error(
      "Renewal invoice email failed:",
      error
    );
  }

  /* ==========================================================
     DM INVOICE
  ========================================================== */

  let discordDmSent =
    false;

  try {
    const user =
      await client.users.fetch(
        renewal.discordUserId
      );

    await user.send({
      content:
        `✅ **Renewal payment verified!**\n\n` +
        `Thank you for renewing with Aura Cloud Hosting! 🎉\n\n` +
        `Your service renewal has been confirmed.\n` +
        `Service: **${renewal.serverName || "Hosting Service"}**\n` +
        `Specifications: ${renewal.ram || "-"} RAM • ${renewal.disk || "-"} Disk • ${renewal.cpu || "-"}\n` +
        `Renewal price: **${formatMoney(invoice.total, currency)}**\n` +
        `New expiry: **${new Date(newExpiryDate).toLocaleString()}**\n\n` +
        `Please wait a little while until the renewal is processed.\n` +
        `Invoice: **${invoiceNumber}** is attached below.`,

      files: [
        new AttachmentBuilder(
          pdfPath,
          {
            name:
              `${invoiceNumber}.pdf`
          }
        )
      ]
    });

    discordDmSent =
      true;
  } catch (error) {
    console.error(
      "Renewal invoice DM failed:",
      error
    );
  }

  /* ==========================================================
     SEND RENEWAL INVOICE TO VERIFICATION CHANNEL
  ========================================================== */

  try {
    const channel = await client.channels.fetch(ADMIN_VERIFICATION_CHANNEL_ID);
    if (channel?.isTextBased()) {
      await channel.send({
        content: `📄 **Renewal invoice created**\nCustomer: <@${renewal.discordUserId}>\nService: **${renewal.serverName || "Hosting Service"}**\nAmount: **${formatMoney(invoice.total, currency)}**`,
        files: [new AttachmentBuilder(pdfPath, { name: `${invoiceNumber}.pdf` })]
      });
    }
  } catch (error) {
    console.error("Could not send renewal invoice to verification channel:", error);
  }

  /* ==========================================================
     RENEWAL CONFIRMATION LOG CHANNEL
  ========================================================== */

  try {
    const renewalLogChannel = await client.channels.fetch(process.env.RENEWAL_LOG_CHANNEL_ID || "1457966756206477375");
    if (renewalLogChannel?.isTextBased()) {
      await renewalLogChannel.send({
        content: `🔄 **Service renewed**\nUser: <@${renewal.discordUserId}>\nService: **${renewal.serverName || "Hosting Service"}**\nOrder: **${renewal.orderNumber}**\nRenewal: **${renewalId}**\nPrice: **${formatMoney(invoice.total, currency)}**\nInvoice: **${invoiceNumber}**`
      });
    }
  } catch (error) {
    console.error("Could not send renewal log:", error);
  }

  /* ==========================================================
     UPDATE ADMIN MESSAGE
  ========================================================== */

  try {
    if (
      renewal.adminVerificationChannelId &&
      renewal.adminVerificationMessageId
    ) {
      const channel =
        await client.channels.fetch(
          renewal.adminVerificationChannelId
        );

      if (
        channel?.isTextBased()
      ) {
        const message =
          await channel.messages.fetch(
            renewal.adminVerificationMessageId
          );

        await message.edit({
          content:
            `✅ Renewal payment verified by <@${adminUser.id}>`,

          embeds: [
            new EmbedBuilder()
              .setTitle(
                "Renewal verified successfully"
              )
              .setDescription(
                "The customer's renewal payment has been verified."
              )
              .addFields(
                {
                  name: "Previous order",
                  value:
                    `\`${renewal.orderNumber}\``,
                  inline: true
                },
                {
                  name: "Renewal",
                  value:
                    `\`${renewalId}\``,
                  inline: true
                },
                {
                  name: "Invoice",
                  value:
                    `\`${invoiceNumber}\``,
                  inline: true
                },
                {
                  name: "Customer",
                  value:
                    `<@${renewal.discordUserId}>`,
                  inline: true
                },
                {
                  name: "Amount",
                  value:
                    formatMoney(
                      invoice.total,
                      currency
                    ),
                  inline: true
                },
                {
                  name: "New expiry",
                  value:
                    new Date(
                      newExpiryDate
                    ).toLocaleString(),
                  inline: true
                },
                {
                  name: "Email invoice",
                  value:
                    emailSent
                      ? "Sent"
                      : "Failed",
                  inline: true
                },
                {
                  name: "Discord invoice",
                  value:
                    discordDmSent
                      ? "Sent"
                      : "Failed",
                  inline: true
                }
              )
              .setTimestamp()
          ],

          components: []
        });
      }
    }
  } catch (error) {
    console.error(
      "Could not update renewal admin message:",
      error
    );
  }

  return {
    alreadyConfirmed: false,
    renewal: invoice,
    invoiceNumber,
    xlsxPath,
    pdfPath,
    emailSent,
    discordDmSent,
    newExpiryDate
  };
}

/* ============================================================
   REGISTER /BUY AND /RENEW
============================================================ */

export async function registerBuyCommand(
  client
) {
  if (
    !client.user ||
    !process.env.ALLOWED_GUILD_ID
  ) {
    return;
  }

  const buyCommand =
    new SlashCommandBuilder()
      .setName("buy")
      .setDescription(
        "Create a hosting order for a Discord user"
      )

      .addUserOption(option =>
        option
          .setName("user")
          .setDescription(
            "Customer to order for"
          )
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("service")
          .setDescription("Service name, e.g. Minecraft, VPS, Rust")
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("ram")
          .setDescription(
            "RAM specification, e.g. 4GB"
          )
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("disk")
          .setDescription(
            "Disk specification, e.g. 50GB NVMe"
          )
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("cpu")
          .setDescription(
            "CPU specification, e.g. 2 vCore"
          )
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("location")
          .setDescription(
            "Server location"
          )
          .setRequired(true)
      )

      .addNumberOption(option =>
        option
          .setName("price")
          .setDescription(
            "Price in the selected currency"
          )
          .setMinValue(0)
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("billing")
          .setDescription("Billing period for this service")
          .setRequired(true)
          .addChoices(
            {
              name: "Monthly",
              value: "monthly"
            },
            {
              name: "Yearly",
              value: "yearly"
            }
          )
      )

      .addStringOption(option =>
        option
          .setName("currency")
          .setDescription(
            "Currency for this order"
          )
          .setRequired(false)
          .addChoices(
            {
              name: "LKR (default)",
              value: "LKR"
            },
            {
              name: "USD",
              value: "USD"
            }
          )
      );

  const renewCommand =
    new SlashCommandBuilder()
      .setName("renew")
      .setDescription("Renew one of your confirmed Aura Cloud services");

  const discountAddCommand =
    new SlashCommandBuilder()
      .setName("discountadd")
      .setDescription("Create an Aura Cloud discount code")
      .addStringOption(option => option
        .setName("type")
        .setDescription("Where this discount can be used")
        .setRequired(true)
        .addChoices(
          { name: "Buy only", value: "buy" },
          { name: "Renew only", value: "renew" },
          { name: "One per account (buy and renew)", value: "one-per-account" }
        ))
      .addStringOption(option => option
        .setName("discount")
        .setDescription("Discount such as 20% or 500")
        .setRequired(true))
      .addStringOption(option => option
        .setName("expiry")
        .setDescription("Expiry: 30d, 9h, 3w, or 2026/12/31")
        .setRequired(true))
      .addStringOption(option => option
        .setName("code")
        .setDescription("Unique code customers will enter")
        .setRequired(true));

  const rest =
    new REST({
      version: "10"
    }).setToken(
      process.env.DISCORD_TOKEN
    );

  await rest.put(
    Routes.applicationGuildCommands(
      client.user.id,
      process.env.ALLOWED_GUILD_ID
    ),
    {
      body: [
        buyCommand.toJSON(),
        renewCommand.toJSON(),
        discountAddCommand.toJSON()
      ]
    }
  );

  console.log(
    "✅ /buy, /renew, and /discountadd commands registered."
  );
}

/* ============================================================
   DISCOUNT CODE ADMIN COMMAND + EXPIRY CLEANUP
============================================================ */

export async function cleanupExpiredDiscountCodes() {
  const db = initFirebase();
  const ref = db.ref("discountCodes");
  const snapshot = await ref.once("value");
  const codes = snapshot.val() || {};
  const now = Date.now();
  const expiredKeys = Object.entries(codes)
    .filter(([, code]) => code?.expiresAt && Number.isFinite(new Date(code.expiresAt).getTime()) && new Date(code.expiresAt).getTime() <= now)
    .map(([key]) => key);

  if (expiredKeys.length) {
    const updates = {};
    for (const key of expiredKeys) updates[key] = null;
    await ref.update(updates);
  }
  return expiredKeys.length;
}

export async function handleDiscountAddCommand(interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== "discountadd") return false;

  const allowedGuild = process.env.ALLOWED_GUILD_ID;
  const allowedRole = process.env.ALLOWED_ROLE_ID;
  const memberRoles = interaction.member?.roles?.cache;
  const isAdmin = Boolean(
    interaction.memberPermissions?.has?.("Administrator") ||
    (allowedRole && memberRoles?.has?.(allowedRole))
  );

  if ((allowedGuild && interaction.guildId !== allowedGuild) || !isAdmin) {
    await interaction.reply({ content: "❌ You do not have permission to create discount codes here.", flags: 64 });
    return true;
  }

  const appliesTo = interaction.options.getString("type", true);
  const discountInput = interaction.options.getString("discount", true);
  const expiryInput = interaction.options.getString("expiry", true);
  const code = normalizeCode(interaction.options.getString("code", true));
  const value = parseDiscountValue(discountInput);
  const expiresAt = parseDuration(expiryInput);

  if (!/^[A-Z0-9_-]{3,50}$/.test(code) || !value || !expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
    await interaction.reply({ content: "❌ Invalid code, discount, or expiry. Use a unique code (3–50 letters/numbers/_/-), a discount like `20%` or `500`, and an expiry like `30d`, `9h`, `3w`, or `2026/12/31`.", flags: 64 });
    return true;
  }

  try {
    await cleanupExpiredDiscountCodes();
    const existing = await getDiscountCode(code);
    if (existing) {
      await interaction.reply({ content: `❌ The code **${code}** already exists. Choose a unique code.`, flags: 64 });
      return true;
    }

    const coupon = {
      code,
      ...value,
      appliesTo,
      onePerAccount: appliesTo === "one-per-account",
      active: true,
      redemptions: {},
      createdAt: new Date().toISOString(),
      createdBy: interaction.user.id,
      expiresAt
    };
    await saveDiscountCode(code, coupon);

    const discountLabel = value.type === "percent" ? `${value.value}% off` : `${value.value.toLocaleString()} fixed discount`;
    const scopeLabel = appliesTo === "one-per-account" ? "Buy and renew; one redemption per account" : `${appliesTo} only`;
    await interaction.reply({
      content: `✅ **Discount code created**\n\n**Code:** \`${code}\`\n**Discount:** ${discountLabel}\n**Applies to:** ${scopeLabel}\n**Expires:** ${new Date(expiresAt).toLocaleString()}\n\nExpired codes are automatically removed during cleanup.`,
      flags: 64
    });
  } catch (error) {
    console.error("/discountadd failed:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "❌ Could not save the discount code. Check Firebase configuration and try again.", flags: 64 });
    } else {
      await interaction.reply({ content: "❌ Could not save the discount code. Check Firebase configuration and try again.", flags: 64 });
    }
  }
  return true;
}

/* ============================================================
   HANDLE /RENEW COMMAND
============================================================ */

export async function handleRenewSlashCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "renew") return false;
  if (!interaction.guildId || interaction.guildId !== process.env.ALLOWED_GUILD_ID) {
    await interaction.reply({ content: "❌ This command is not available here.", flags: 64 }); return true;
  }

  const db = initFirebase();
  const snap = await db.ref("orders").once("value");
  const all = snap.val() || {};
  const confirmed = Object.values(all).filter(o =>
    o?.discordUserId === interaction.user.id &&
    isOriginalBuyOrder(o)
  );

  if (!confirmed.length) {
    await interaction.reply({ content: "❌ You have no confirmed service available for renewal.", flags: 64 }); return true;
  }

  const first = confirmed[0];
  const email = first.customer?.email || await getSavedCustomerEmail(interaction.user.id);
  if (!email) { await interaction.reply({ content: "❌ Your original service does not have an email address saved. Please use /buy once to save your email, then retry /renew.", flags: 64 }); return true; }
  await saveCustomerEmail(interaction.user.id, email, interaction.user.username);

  const renewalId = generateRenewalId(first.orderNumber || interaction.user.id);
  const otp = generateOtp();
  const candidates = confirmed.map(o => ({
    orderNumber: o.orderNumber,
    serviceName: serviceLabel(o),
    serviceType: String(serviceLabel(o)).toLowerCase().replace(/\s+/g, "-").slice(0, 40),
    ram: o.ram || "Not specified",
    disk: o.disk || "Not specified",
    cpu: o.cpu || "Not specified",
    location: o.location || "Not specified",
    expiryDate: o.currentExpiryDate || o.serviceExpiryDate || o.expiryDate || "Not recorded"
  }));

  const renewal = {
    renewalId,
    discordUserId: interaction.user.id,
    discordUsername: interaction.user.tag || interaction.user.username,
    customer: { ...(first.customer || {}), email },
    currency: String(first.currency || "LKR").toUpperCase() === "USD" ? "USD" : "LKR",
    candidates,
    status: "otp_pending",
    otpHash: hashOtp(otp),
    otpExpiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    otpAttempts: 0,
    createdAt: new Date().toISOString()
  };

  await saveRenewalDb(renewalId, renewal);
  try { await sendOrderOtp(email, renewalId, otp); } catch (e) {
    await updateRenewalDb(renewalId, { status: "email_failed", otpHash: null, otpExpiresAt: null });
    await interaction.reply({ content: "❌ I could not send the renewal OTP email. Please try again later.", flags: 64 }); return true;
  }

  try {
    const user = await interaction.client.users.fetch(interaction.user.id);
    await user.send({ embeds: [new EmbedBuilder().setTitle("🔐 Renewal verification").setDescription(`A verification code was sent to **${email}**. Click the button below and enter the OTP.`).addFields({ name: "Available services", value: candidates.map((s,i) => `${i+1}. ${s.serviceName} — ${s.ram} RAM / ${s.disk} Disk / ${s.cpu}`).join("\n") }).setTimestamp()], components: [buildRenewOtpButton(renewalId)] });
    await interaction.reply({ content: "✅ I sent a renewal verification message to your Discord DM. Please check your DMs.", flags: 64 });
  } catch (e) {
    await interaction.reply({ content: "❌ I could not DM you. Enable DMs from this server and run `/renew` again.", flags: 64 });
  }
  return true;
}

export async function handleBuyInteraction(interaction) {
  const customId = interaction.customId || "";

  /* ---------------- ADMIN REJECTION MODALS ---------------- */
  if (interaction.isModalSubmit() && customId.startsWith("order_reject_modal:")) {
    if (!isVerificationAdmin(interaction)) {
      await interaction.reply({ content: "❌ You do not have permission to reject orders.", flags: 64 });
      return true;
    }
    const orderId = customId.split(":")[1];
    const order = await getOrder(orderId);
    if (!order) { await interaction.reply({ content: "❌ Order not found.", flags: 64 }); return true; }
    const reason = interaction.fields.getTextInputValue("reason").trim();
    await updateOrder(orderId, {
      status: "payment_rejected",
      rejectionReason: reason,
      paymentVerificationRejectedAt: new Date().toISOString(),
      paymentVerificationRejectedBy: { userId: interaction.user.id, username: interaction.user.tag || interaction.user.username }
    });
    try {
      const user = await interaction.client.users.fetch(order.discordUserId);
      await user.send({
        embeds: [new EmbedBuilder().setTitle("❌ Payment rejected").setDescription(`Your payment for order **${order.orderNumber}** was rejected.\n\n**Reason:** ${reason}\n\nYou can choose a payment method again below.`).setTimestamp()],
        components: [buildPaymentButtons(orderId)]
      });
    } catch (e) { console.error("Could not DM rejection:", e); }
    await interaction.update({ content: `❌ Order **${orderId}** rejected by <@${interaction.user.id}>.\nReason: **${reason}**`, embeds: [], components: [] });
    return true;
  }

  if (interaction.isModalSubmit() && customId.startsWith("renew_reject_modal:")) {
    if (!isVerificationAdmin(interaction)) {
      await interaction.reply({ content: "❌ You do not have permission to reject renewals.", flags: 64 });
      return true;
    }
    const renewalId = customId.split(":")[1];
    const renewal = await getRenewal(renewalId);
    if (!renewal) { await interaction.reply({ content: "❌ Renewal not found.", flags: 64 }); return true; }
    const reason = interaction.fields.getTextInputValue("reason").trim();
    await updateRenewalDb(renewalId, {
      status: "payment_rejected",
      rejectionReason: reason,
      paymentVerificationRejectedAt: new Date().toISOString(),
      paymentVerificationRejectedBy: { userId: interaction.user.id, username: interaction.user.tag || interaction.user.username }
    });
    try {
      const user = await interaction.client.users.fetch(renewal.discordUserId);
      await user.send({
        embeds: [new EmbedBuilder().setTitle("❌ Renewal payment rejected").setDescription(`Your renewal payment for **${renewal.orderNumber}** was rejected.\n\n**Reason:** ${reason}\n\nYou can choose a payment method again below.`).setTimestamp()],
        components: [buildRenewPaymentButtons(renewalId)]
      });
    } catch (e) { console.error("Could not DM renewal rejection:", e); }
    await interaction.update({ content: `❌ Renewal **${renewalId}** rejected by <@${interaction.user.id}>.\nReason: **${reason}**`, embeds: [], components: [] });
    return true;
  }

  /* ---------------- ADMIN BUTTONS ---------------- */
  if (interaction.isButton() && customId.startsWith("order_reject:")) {
    if (!isVerificationAdmin(interaction)) {
      await interaction.reply({ content: "❌ You do not have permission to reject orders.", flags: 64 });
      return true;
    }
    const orderId = customId.split(":")[1];
    const modal = new ModalBuilder().setCustomId(`order_reject_modal:${orderId}`).setTitle("Reject Payment");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Reason for rejection").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(1000).setPlaceholder("Example: Receipt amount does not match the order.")
    ));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isButton() && customId.startsWith("renew_reject:")) {
    if (!isVerificationAdmin(interaction)) {
      await interaction.reply({ content: "❌ You do not have permission to reject renewals.", flags: 64 });
      return true;
    }
    const renewalId = customId.split(":")[1];
    const modal = new ModalBuilder().setCustomId(`renew_reject_modal:${renewalId}`).setTitle("Reject Renewal Payment");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Reason for rejection").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(1000).setPlaceholder("Example: Receipt amount does not match the renewal.")
    ));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isButton() && customId.startsWith("order_verify:")) {
    if (!isVerificationAdmin(interaction)) { await interaction.reply({ content: "❌ You do not have permission to verify orders.", flags: 64 }); return true; }
    const orderId = customId.split(":")[1];
    const order = await getOrder(orderId);
    if (!order) { await interaction.reply({ content: "❌ Order not found.", flags: 64 }); return true; }
    await interaction.deferUpdate();
    try {
      const result = await finalizeOrder(orderId, interaction.user, interaction, interaction.client);
      await interaction.followUp({ content: `✅ Order **${orderId}** confirmed. Invoice **${result.invoiceNumber}** was created and sent to the customer.`, flags: 64 });
    } catch (e) { await interaction.followUp({ content: `❌ Could not confirm order: ${e.message}`, flags: 64 }); }
    return true;
  }

  if (interaction.isButton() && customId.startsWith("renew_verify:")) {
    if (!isVerificationAdmin(interaction)) { await interaction.reply({ content: "❌ You do not have permission to verify renewals.", flags: 64 }); return true; }
    const renewalId = customId.split(":")[1];
    const renewal = await getRenewal(renewalId);
    if (!renewal) { await interaction.reply({ content: "❌ Renewal not found.", flags: 64 }); return true; }
    await interaction.deferUpdate();
    try {
      const result = await finalizeRenewal(renewalId, interaction.user, interaction.client);
      await interaction.followUp({ content: `✅ Renewal **${renewalId}** confirmed. Invoice **${result.invoiceNumber}** was created and sent to the customer.`, flags: 64 });
    } catch (e) { await interaction.followUp({ content: `❌ Could not confirm renewal: ${e.message}`, flags: 64 }); }
    return true;
  }

  /* ---------------- CUSTOMER BUY FLOW ---------------- */
  if (interaction.isButton() && customId.startsWith("buy_start:")) {
    const orderId = customId.split(":")[1];
    const order = await getOrder(orderId);
    if (!order || order.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Order not found or assigned to another user.", flags: 64 }); return true; }
    const savedEmail = await getSavedCustomerEmail(interaction.user.id);
    if (savedEmail) {
      await interaction.deferReply({ flags: 64 });
      const otp = generateOtp();
      await updateOrder(orderId, { customer: { name: interaction.user.username, email: savedEmail }, otpHash: hashOtp(otp), otpExpiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(), otpAttempts: 0, status: "otp_pending" });
      try {
        await sendOrderOtp(savedEmail, orderId, otp);
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🔐 Verify your saved email")
          .setDescription(`Your saved email **${savedEmail}** is linked to your Discord account. A fresh OTP has been sent to it.`)
          .addFields({ name: "Order", value: `\`${orderId}\``, inline: true }, { name: "Specifications", value: specsText(order) }).setTimestamp()], components: [buildOtpButton(orderId)] });
      } catch (e) {
        await updateOrder(orderId, { status: "created", otpHash: null, otpExpiresAt: null });
        await interaction.editReply("❌ I could not send the OTP to your saved email. Please contact support or update your saved email.");
      }
      return true;
    }
    const modal = new ModalBuilder().setCustomId(`buy_details:${orderId}`).setTitle("Save your email for Aura Cloud");
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("email").setLabel("Email address (saved to your Discord account)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("you@example.com")));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && customId.startsWith("buy_details:")) {
    const orderId = customId.split(":")[1];
    const order = await getOrder(orderId);
    if (!order || order.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Order not found or not assigned to you.", flags: 64 }); return true; }
    await interaction.deferReply({ flags: 64 });
    const email = interaction.fields.getTextInputValue("email").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { await interaction.editReply("❌ Please enter a valid email address."); return true; }
    const otp = generateOtp();
    try {
      await saveCustomerEmail(interaction.user.id, email, interaction.user.username);
      await updateOrder(orderId, { customer: { name: interaction.user.username, email }, otpHash: hashOtp(otp), otpExpiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(), otpAttempts: 0, status: "otp_pending" });
      await sendOrderOtp(email, orderId, otp);
    } catch (e) {
      console.error("Could not save customer email/send OTP:", e);
      await updateOrder(orderId, { status: "created", otpHash: null, otpExpiresAt: null });
      await interaction.editReply("❌ I could not save your email or send the OTP. Check Firebase/email setup and try again.");
      return true;
    }
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("📧 Email saved and OTP sent")
      .setDescription(`Your email **${email}** is now linked to your Discord account for future purchases and renewals. A verification OTP has been sent.`)
      .addFields({ name: "Order", value: `\`${orderId}\``, inline: true }, { name: "Specifications", value: specsText(order) }).setTimestamp()], components: [buildOtpButton(orderId)] });
    return true;
  }

  if (interaction.isButton() && customId.startsWith("buy_otp:")) {
    const orderId = customId.split(":")[1];
    const order = await getOrder(orderId);
    if (!order || order.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Order not found.", flags: 64 }); return true; }
    const modal = new ModalBuilder().setCustomId(`buy_verify:${orderId}`).setTitle("Enter Email OTP");
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("otp").setLabel("6-digit OTP").setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6).setRequired(true).setPlaceholder("123456")));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && customId.startsWith("buy_verify:")) {
    const orderId = customId.split(":")[1];
    const order = await getOrder(orderId);
    if (!order || order.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Order not found or not assigned to you.", flags: 64 }); return true; }
    await interaction.deferReply({ flags: 64 });
    if (order.status !== "otp_pending" || !order.otpExpiresAt || Date.now() > new Date(order.otpExpiresAt).getTime()) { await interaction.editReply("❌ This OTP has expired. Start the order again."); return true; }
    const entered = interaction.fields.getTextInputValue("otp").trim();
    if (hashOtp(entered) !== order.otpHash) { await interaction.editReply("❌ Incorrect OTP."); return true; }
    await updateOrder(orderId, { status: "discount_prompt", otpHash: null, otpExpiresAt: null, verifiedAt: new Date().toISOString() });
    const user = await interaction.client.users.fetch(order.discordUserId);
    await user.send({ embeds: [new EmbedBuilder().setTitle("🎟️ Do you have a discount code?")
      .setDescription("Your email is verified. Choose **Yes** to enter a discount code, or **No** to continue to the normal payment panel.")
      .addFields({ name: "Order", value: `\`${order.orderNumber}\``, inline: true }, { name: "Current price", value: formatMoney(order.price, currencyOf(order)), inline: true }).setTimestamp()], components: [buildDiscountPrompt("buy", orderId)] });
    await interaction.editReply("✅ Email verified. I sent you a DM asking whether you have a discount code.");
    return true;
  }

  if (interaction.isButton() && customId.startsWith("buy_discount_yes:")) {
    const id = customId.split(":")[1]; const order = await getOrder(id);
    if (!order || order.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Order not found.", flags: 64 }); return true; }
    await interaction.showModal(buildDiscountCodeModal("buy", id)); return true;
  }

  if (interaction.isModalSubmit() && customId.startsWith("buy_discount_code:")) {
    const id = customId.split(":")[1]; const order = await getOrder(id);
    if (!order || order.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Order not found.", flags: 64 }); return true; }
    await interaction.deferReply({ flags: 64 });
    const code = interaction.fields.getTextInputValue("code").trim();
    const result = await applyDiscount(order, code);
    if (!result.valid) { await interaction.editReply(`❌ ${result.message} You can try again from the discount prompt or continue without a code.`); return true; }
    const discount = money(result.discount); const total = Math.max(0, money(order.price) - discount);
    await updateOrder(id, { discount, discountCode: normalizeCode(code), total, couponId: result.coupon?.code || normalizeCode(code), status: "awaiting_payment" });
    await interaction.editReply(`✅ Discount **${normalizeCode(code)}** applied. You saved ${formatMoney(discount, currencyOf(order))}. Opening your payment panel…`);
    await showBuyPaymentPanel(interaction.client, id, interaction.user.id); return true;
  }

  if (interaction.isButton() && customId.startsWith("buy_discount_no:")) {
    const id = customId.split(":")[1]; const order = await getOrder(id);
    if (!order || order.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Order not found.", flags: 64 }); return true; }
    await updateOrder(id, { discount: 0, discountCode: "", total: money(order.price), status: "awaiting_payment" });
    await interaction.update({ content: "No discount code selected. Opening the normal payment panel…", embeds: [], components: [] });
    await showBuyPaymentPanel(interaction.client, id, interaction.user.id); return true;
  }

  if (interaction.isButton() && customId.startsWith("buy_pay:")) {
    const [, orderId, method] = customId.split(":");

    // Acknowledge the button immediately. Firebase/network work can take
    // longer than Discord's initial interaction window.
    try {
      await interaction.deferUpdate();
    } catch (error) {
      console.error("Buy payment interaction acknowledgement failed:", error);
      return true;
    }

    try {
      const order = await getOrder(orderId);
      const payment = PAYMENTS[method];

      if (!order || order.discordUserId !== interaction.user.id || !payment) {
        await interaction.message.edit({
          content: "❌ This payment request is invalid or has expired. Please start a new /buy flow.",
          embeds: [],
          components: []
        });
        return true;
      }

      if (!["awaiting_payment", "payment_selected", "payment_rejected"].includes(order.status)) {
        await interaction.message.edit({
          content: "❌ This order is not ready for payment. Please start a new /buy flow.",
          embeds: [],
          components: []
        });
        return true;
      }

      const total = money(
        order.total ?? (money(order.price) - money(order.discount))
      );

      await updateOrder(orderId, {
        status: "payment_selected",
        paymentMethod: payment.label,
        paymentMethodKey: method,
        total,
        paymentPanelMessageId: interaction.message.id,
        paymentPanelChannelId: interaction.message.channelId,
        paymentSelectedAt: new Date().toISOString()
      });

      const paymentEmbed = new EmbedBuilder()
        .setTitle(`${payment.emoji} ${payment.label}`)
        .addFields(
          { name: "Order", value: `\`${order.orderNumber}\``, inline: true },
          { name: "Billing", value: order.billingCycle === "yearly" ? "Yearly" : "Monthly", inline: true },
          { name: "Amount", value: formatMoney(total, currencyOf(order)), inline: true },
          { name: "Specifications", value: specsText(order), inline: false }
        )
        .setTimestamp();

      if (method === "other") {
        const checkoutToken = crypto.randomBytes(32).toString("hex");
        const pageUrl = checkoutPageUrl("buy", order.orderNumber, checkoutToken);
        await updateOrder(orderId, {
          status: "payment_selected",
          paymentMethod: payment.label,
          paymentMethodKey: "other",
          total,
          checkoutTokenHash: checkoutTokenHash(checkoutToken),
          checkoutToken: null,
          checkoutKind: "buy",
          checkoutCreatedAt: new Date().toISOString(),
          checkoutExpiresAt: new Date(Date.now() + ORDER_TTL_MS).toISOString(),
          paypalOrderId: null,
          paypalAmount: null,
          paypalCurrency: null,
          paypalApprovalUrl: PAYPAL_HOSTED_PAYMENT_URL,
          checkoutUrl: PAYPAL_HOSTED_PAYMENT_URL,
          paymentSelectedAt: new Date().toISOString()
        });
        paymentEmbed.setDescription(
          "Open the Aura Cloud checkout page to review your exact order total and use PayPal's official hosted payment button. After paying, return to this DM and upload your PayPal receipt or transaction proof. The order stays pending until Aura Cloud verifies the payment."
        );
        const checkoutRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Open Other Payment")
            .setStyle(ButtonStyle.Link)
            .setURL(pageUrl)
        );
        await interaction.message.edit({ embeds: [paymentEmbed], components: [checkoutRow] });
        return true;
      }

      if (method === "paypal" || method === "card") {
        if (!paypalConfigured()) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.");
        const checkoutToken = crypto.randomBytes(32).toString("hex");
        const checkoutRecord = { ...order, total, paymentMethodKey: method };
        let paypalCheckout = null;
        let usdAmount;
        if (method === "paypal") {
          paypalCheckout = await createPayPalCheckout(checkoutRecord, method, "buy", order.orderNumber);
          usdAmount = paypalCheckout.amount;
        } else {
          usdAmount = await paypalUsdAmount(checkoutRecord);
        }

        const pageUrl = checkoutPageUrl("buy", order.orderNumber, checkoutToken);
        await updateOrder(orderId, {
          status: "payment_selected",
          paymentMethod: payment.label,
          paymentMethodKey: method,
          total,
          checkoutTokenHash: checkoutTokenHash(checkoutToken),
          checkoutToken: null,
          checkoutKind: "buy",
          checkoutCreatedAt: new Date().toISOString(),
          checkoutExpiresAt: new Date(Date.now() + ORDER_TTL_MS).toISOString(),
          paypalOrderId: paypalCheckout?.id || null,
          paypalAmount: String(usdAmount),
          paypalCurrency: "USD",
          paypalApprovalUrl: paypalCheckout?.approvalUrl || null,
          checkoutUrl: paypalCheckout?.approvalUrl || null,
          paypalCreatedAt: paypalCheckout ? new Date().toISOString() : null,
          paymentSelectedAt: new Date().toISOString()
        });

        paymentEmbed.setDescription(method === "card"
          ? "Review your order on the Aura Cloud checkout page and enter your card details in PayPal's secure fields without leaving the page."
          : "Review your order on the Aura Cloud checkout page, then continue to PayPal to sign in and approve the payment.");
        paymentEmbed.addFields({ name: "PayPal charge", value: formatMoney(usdAmount, "USD"), inline: true });
        const checkoutRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel(method === "card" ? "Open Secure Card Checkout" : "Review & Pay with PayPal")
            .setStyle(ButtonStyle.Link)
            .setURL(pageUrl)
        );
        await interaction.message.edit({ embeds: [paymentEmbed], components: [checkoutRow] });
      } else {
        paymentEmbed.setDescription(
          `Please pay **${formatMoney(total, currencyOf(order))}** using these details:\n\n` +
          `**Payment details:**\n${payment.detail()}\n\n` +
          `After paying, **upload the receipt image/PDF in this DM**. The bot will send it to the verification channel for admin verification.`
        );
        await interaction.message.edit({
          embeds: [paymentEmbed],
          components: []
        });
      }
    } catch (error) {
      console.error("Buy payment selection failed:", error);
      try {
        await interaction.message.edit({
          content: "❌ Could not process this payment selection. Please start a new /buy flow and try again.",
          embeds: [],
          components: []
        });
      } catch (editError) {
        console.error("Could not edit failed payment message:", editError);
      }
    }

    return true;
  }

  /* ---------------- CUSTOMER RENEWAL FLOW ---------------- */
  if (interaction.isButton() && customId.startsWith("renew_otp:")) {
    const renewalId = customId.split(":")[1];
    const renewal = await getRenewal(renewalId);
    if (!renewal || renewal.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Renewal not found.", flags: 64 }); return true; }
    const modal = new ModalBuilder().setCustomId(`renew_verify:${renewalId}`).setTitle("Verify Renewal Email");
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("otp").setLabel("6-digit OTP").setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6).setRequired(true).setPlaceholder("123456")));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && customId.startsWith("renew_verify:")) {
    const renewalId = customId.split(":")[1];
    const renewal = await getRenewal(renewalId);
    if (!renewal || renewal.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Renewal not found.", flags: 64 }); return true; }
    await interaction.deferReply({ flags: 64 });
    if (renewal.status !== "otp_pending" || !renewal.otpExpiresAt || Date.now() > new Date(renewal.otpExpiresAt).getTime()) { await interaction.editReply("❌ This OTP has expired. Start `/renew` again."); return true; }
    const entered = interaction.fields.getTextInputValue("otp").trim();
    if (hashOtp(entered) !== renewal.otpHash) { await interaction.editReply("❌ Incorrect OTP."); return true; }
    await updateRenewalDb(renewalId, { ...renewal, status: "discount_prompt", pendingDiscountCode: "", otpHash: null, otpExpiresAt: null, verifiedAt: new Date().toISOString() });
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🎟️ Do you have a discount code?").setDescription("Choose **Yes** to enter a code or **No** to continue to service selection and the normal renewal payment panel.").setTimestamp()], components: [buildDiscountPrompt("renew", renewalId)] });
    return true;
  }

  if (interaction.isButton() && customId.startsWith("renew_discount_yes:")) {
    const id = customId.split(":")[1]; const renewal = await getRenewal(id);
    if (!renewal || renewal.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Renewal not found.", flags: 64 }); return true; }
    await interaction.showModal(buildDiscountCodeModal("renew", id)); return true;
  }

  if (interaction.isModalSubmit() && customId.startsWith("renew_discount_code:")) {
    const id = customId.split(":")[1]; const renewal = await getRenewal(id);
    if (!renewal || renewal.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Renewal not found.", flags: 64 }); return true; }
    await interaction.deferReply({ flags: 64 });
    const code = interaction.fields.getTextInputValue("code").trim();
    await updateRenewalDb(id, { ...renewal, pendingDiscountCode: normalizeCode(code), status: "service_selection" });
    const updated = { ...renewal, pendingDiscountCode: normalizeCode(code) };
    await showRenewServiceSelection(interaction, updated, false);
    return true;
  }

  if (interaction.isButton() && customId.startsWith("renew_discount_no:")) {
    const id = customId.split(":")[1]; const renewal = await getRenewal(id);
    if (!renewal || renewal.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Renewal not found.", flags: 64 }); return true; }
    const updated = { ...renewal, pendingDiscountCode: "", status: "service_selection" };
    await updateRenewalDb(id, { pendingDiscountCode: "", status: "service_selection" });
    await showRenewServiceSelection(interaction, updated, true);
    return true;
  }

  if (interaction.isButton() && customId.startsWith("renew_service:")) {
    const [, renewalId, sourceOrderNumber] = customId.split(":");
    const renewal = await getRenewal(renewalId);
    if (!renewal || renewal.discordUserId !== interaction.user.id) { await interaction.reply({ content: "❌ Renewal not found.", flags: 64 }); return true; }
    const service = (renewal.candidates || []).find(s => s.orderNumber === sourceOrderNumber);
    if (!service) { await interaction.reply({ content: "❌ Service not found.", flags: 64 }); return true; }
    const key = service.serviceType;
    const sourceOrder = await getOrder(sourceOrderNumber);

    // Renewal always uses the exact price and currency originally entered in /buy.
    // There are no separate renewal prices in .env.
    const originalPrice = money(sourceOrder?.price);
    const originalCurrency = String(sourceOrder?.currency || "LKR").toUpperCase();

    if (!sourceOrder || !originalPrice) {
      await interaction.reply({
        content: "❌ The original /buy order price could not be found, so this service cannot be renewed.",
        flags: 64
      });
      return true;
    }

    const newRenewalOrderNumber = await getNextOrderNumber();
    const updated = {
      ...renewal,
      ...service,
      orderNumber: newRenewalOrderNumber,
      sourceOrderNumber,
      serverName: service.serviceName,
      serviceType: key,
      price: originalPrice,
      total: originalPrice,
      currency: originalCurrency,
      originalBuyPrice: originalPrice,
      originalBuyCurrency: originalCurrency,
      status: "awaiting_payment",
      billingCycle: sourceOrder.billingCycle || sourceOrder.billingPeriod || "monthly",
      billingPeriod: sourceOrder.billingCycle || sourceOrder.billingPeriod || "monthly",
      sourceOrder
    };
    const discountResult = updated.pendingDiscountCode ? await applyDiscount(updated, updated.pendingDiscountCode) : { valid: false, discount: 0 };
    if (updated.pendingDiscountCode && !discountResult.valid) {
      updated.discountNotice = `Discount code ${updated.pendingDiscountCode} was not accepted; normal price applied.`;
      updated.pendingDiscountCode = "";
    }
    updated.discount = discountResult.valid ? money(discountResult.discount) : 0;
    updated.discountCode = discountResult.valid ? normalizeCode(updated.pendingDiscountCode) : "";
    updated.total = Math.max(0, originalPrice - updated.discount);
    updated.pendingDiscountCode = "";
    await saveRenewalDb(renewalId, updated);
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔄 Renewal ready")
          .setDescription(`Your renewal uses the original /buy price, currency, and billing period. Select a payment method below.${updated.discountNotice ? `\n\n⚠️ ${updated.discountNotice}` : ""}`)
          .addFields(
            { name: "Service", value: service.serviceName, inline: true },
            { name: "Billing", value: updated.billingCycle === "yearly" ? "Yearly" : "Monthly", inline: true },
            { name: "Renewal price", value: formatMoney(updated.total, updated.currency), inline: true },
            { name: "Discount", value: updated.discountCode ? `${updated.discountCode} — ${formatMoney(updated.discount, updated.currency)} off` : "None", inline: true },
            { name: "Specifications", value: specsText(updated) }
          )
          .setTimestamp()
      ],
      components: [buildRenewPaymentButtons(renewalId)]
    });
    return true;
  }

  if (interaction.isButton() && customId.startsWith("renew_pay:")) {
    const [, renewalId, method] = customId.split(":");
    const renewal = await getRenewal(renewalId);
    const payment = PAYMENTS[method];
    if (!renewal || renewal.discordUserId !== interaction.user.id || !payment) {
      await interaction.reply({ content: "❌ Invalid renewal payment request.", flags: 64 });
      return true;
    }
    if (!["awaiting_payment", "payment_selected", "payment_rejected"].includes(renewal.status)) {
      await interaction.reply({ content: "❌ This renewal is not ready for payment.", flags: 64 });
      return true;
    }

    const total = money(renewal.total ?? renewal.price);
    if (method === "other") {
      try {
        const checkoutToken = crypto.randomBytes(32).toString("hex");
        const pageUrl = checkoutPageUrl("renewal", renewalId, checkoutToken);
        await updateRenewalDb(renewalId, {
          ...renewal,
          status: "payment_selected",
          paymentVerified: false,
          paymentMethod: payment.label,
          paymentMethodKey: "other",
          total,
          paymentPanelMessageId: interaction.message.id,
          paymentPanelChannelId: interaction.message.channelId,
          checkoutTokenHash: checkoutTokenHash(checkoutToken),
          checkoutToken: null,
          checkoutKind: "renewal",
          checkoutCreatedAt: new Date().toISOString(),
          checkoutExpiresAt: new Date(Date.now() + ORDER_TTL_MS).toISOString(),
          paypalOrderId: null,
          paypalAmount: null,
          paypalCurrency: null,
          paypalApprovalUrl: PAYPAL_HOSTED_PAYMENT_URL,
          checkoutUrl: PAYPAL_HOSTED_PAYMENT_URL,
          paymentSelectedAt: new Date().toISOString()
        });
        const embed = new EmbedBuilder()
          .setTitle("🌐 Other Payment — Renewal")
          .setDescription("Review the renewal total on the Aura Cloud checkout page and use PayPal's official hosted payment button. Return to this DM and upload your receipt; the renewal stays pending until Aura Cloud verifies the payment.")
          .addFields(
            { name: "Renewal", value: `${renewalId}`, inline: true },
            { name: "Amount", value: formatMoney(total, currencyOf(renewal)), inline: true },
            { name: "Service", value: renewal.serverName || renewal.serviceName || "Hosting Service", inline: true },
            { name: "Billing", value: renewal.billingCycle === "yearly" ? "Yearly" : "Monthly", inline: true },
            { name: "Specifications", value: specsText(renewal), inline: false }
          )
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("Open Other Payment").setStyle(ButtonStyle.Link).setURL(pageUrl)
        );
        await interaction.update({ embeds: [embed], components: [row] });
      } catch (error) {
        console.error("Renewal hosted checkout creation failed:", error);
        await interaction.update({ content: "❌ Could not create the payment page. Please try again or contact Aura Cloud support.", embeds: [], components: [] });
      }
      return true;
    }

    if (method === "paypal" || method === "card") {
      try {
        if (!paypalConfigured()) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.");
        const checkoutToken = crypto.randomBytes(32).toString("hex");
        const checkoutRecord = { ...renewal, total, paymentMethodKey: method };
        let paypalCheckout = null;
        let usdAmount;
        if (method === "paypal") {
          paypalCheckout = await createPayPalCheckout(checkoutRecord, method, "renewal", renewalId);
          usdAmount = paypalCheckout.amount;
        } else {
          usdAmount = await paypalUsdAmount(checkoutRecord);
        }
        const pageUrl = checkoutPageUrl("renewal", renewalId, checkoutToken);
        await updateRenewalDb(renewalId, {
          ...renewal,
          status: "payment_selected",
          paymentVerified: false,
          paymentMethod: payment.label,
          paymentMethodKey: method,
          total,
          paymentPanelMessageId: interaction.message.id,
          paymentPanelChannelId: interaction.message.channelId,
          checkoutTokenHash: checkoutTokenHash(checkoutToken),
          checkoutToken: null,
          checkoutKind: "renewal",
          checkoutCreatedAt: new Date().toISOString(),
          checkoutExpiresAt: new Date(Date.now() + ORDER_TTL_MS).toISOString(),
          paypalOrderId: paypalCheckout?.id || null,
          paypalAmount: String(usdAmount),
          paypalCurrency: "USD",
          paypalApprovalUrl: paypalCheckout?.approvalUrl || null,
          checkoutUrl: paypalCheckout?.approvalUrl || null,
          paypalCreatedAt: paypalCheckout ? new Date().toISOString() : null,
          paymentSelectedAt: new Date().toISOString()
        });

        const embed = new EmbedBuilder()
          .setTitle(method === "card" ? "💳 Secure Card Renewal Checkout" : "💙 PayPal Renewal Checkout")
          .setDescription(method === "card"
            ? "Review your renewal on the Aura Cloud checkout page and pay using PayPal's secure card fields."
            : "Review your renewal on the Aura Cloud checkout page, then continue to PayPal to sign in and approve payment.")
          .addFields(
            { name: "Renewal", value: `\`${renewalId}\``, inline: true },
            { name: "Amount", value: formatMoney(total, currencyOf(renewal)), inline: true },
            { name: "PayPal charge", value: formatMoney(usdAmount, "USD"), inline: true },
            { name: "Service", value: renewal.serverName || renewal.serviceName || "Hosting Service", inline: true },
            { name: "Billing", value: renewal.billingCycle === "yearly" ? "Yearly" : "Monthly", inline: true },
            { name: "Specifications", value: specsText(renewal), inline: false }
          )
          .setFooter({ text: "Aura Cloud verifies the captured amount before confirming a renewal." })
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel(method === "card" ? "Open Secure Card Checkout" : "Review & Pay with PayPal")
            .setStyle(ButtonStyle.Link)
            .setURL(pageUrl)
        );
        await interaction.update({ embeds: [embed], components: [row] });
      } catch (error) {
        console.error("Renewal PayPal checkout creation failed:", error);
        await interaction.update({ content: "❌ Could not create the secure checkout. Please try again or contact Aura Cloud support.", embeds: [], components: [] });
      }
      return true;
    }

    await updateRenewalDb(renewalId, {
      ...renewal,
      status: "payment_selected",
      paymentMethod: payment.label,
      paymentMethodKey: method,
      total,
      paymentPanelMessageId: interaction.message.id,
      paymentPanelChannelId: interaction.message.channelId,
      paymentSelectedAt: new Date().toISOString()
    });
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${payment.emoji} ${payment.label}`)
          .setDescription(`Please pay **${formatMoney(total, currencyOf(renewal))}** using these details:\n\n**Payment details:**\n${payment.detail()}\n\nAfter paying, **upload the receipt image/PDF in this DM**.`)
          .addFields(
            { name: "Service", value: renewal.serverName, inline: true },
            { name: "Billing", value: renewal.billingCycle === "yearly" ? "Yearly" : "Monthly", inline: true },
            { name: "Amount", value: formatMoney(total, currencyOf(renewal)), inline: true },
            { name: "Specifications", value: specsText(renewal) }
          )
          .setTimestamp()
      ],
      components: []
    });
    return true;
  }

  return false;
}

/* ============================================================
   /BUY COMMAND
============================================================ */

export async function handleBuySlashCommand(
  interaction
) {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== "buy"
  ) {
    return false;
  }

  if (
    interaction.guildId !==
    process.env.ALLOWED_GUILD_ID
  ) {
    await interaction.reply({
      content:
        "❌ This command is not available in this server.",
      flags: 64
    });

    return true;
  }

  const buyAdminRoleId = process.env.BUY_ADMIN_ROLE_ID || "1556314578273706076";

  if (
    !interaction.member?.roles?.cache?.has(buyAdminRoleId)
  ) {
    await interaction.reply({
      content:
        "❌ You are not authorized to create orders.",
      flags: 64
    });

    return true;
  }

  // A /buy command can perform Firebase work before the first response.
  // Defer immediately after the cheap permission checks so Discord's 3-second
  // interaction acknowledgement window cannot expire.
  await interaction.deferReply();

  const user =
    interaction.options.getUser(
      "user",
      true
    );

  const service =
    interaction.options.getString("service", true).trim();

  const ram =
    interaction.options.getString(
      "ram",
      true
    );

  const disk =
    interaction.options.getString(
      "disk",
      true
    );

  const cpu =
    interaction.options.getString(
      "cpu",
      true
    );

  const location =
    interaction.options.getString(
      "location",
      true
    );

  const price =
    money(
      interaction.options.getNumber(
        "price",
        true
      )
    );

  const currency =
    interaction.options
      .getString(
        "currency"
      ) || "LKR";

  const normalizedCurrency = currency.toUpperCase();

  const billingCycle =
    interaction.options.getString("billing", true).toLowerCase();

  if (
    normalizedCurrency !== "LKR" &&
    normalizedCurrency !== "USD"
  ) {
    await interaction.editReply("❌ Currency must be LKR or USD.");
    return true;
  }

  if (billingCycle !== "monthly" && billingCycle !== "yearly") {
    await interaction.editReply("❌ Billing period must be monthly or yearly.");
    return true;
  }

  const orderNumber =
    await getNextOrderNumber();

  const order = {
    orderNumber,

    discordUserId:
      user.id,

    discordUsername:
      user.tag,

    service,
    serviceName: service,

    ram,

    disk,

    cpu,

    location,

    price,

    currency: normalizedCurrency,

    billingCycle,

    billingPeriod: billingCycle,

    discount: 0,

    discountCode: "",

    total: price,

    status:
      "created",

    createdAt:
      new Date().toISOString(),

    expiresAt:
      new Date(
        Date.now() +
        ORDER_TTL_MS
      ).toISOString(),

    createdBy:
      interaction.user.id
  };

  await saveOrder(
    orderNumber,
    order
  );

  const embed =
    new EmbedBuilder()
      .setTitle(
        "Aura Cloud Hosting Order"
      )
      .setDescription(
        `Order created for <@${user.id}>. Click the button to continue.`
      )
      .addFields(
        {
          name: "Customer",
          value:
            `<@${user.id}>`,
          inline: true
        },
        {
          name: "Order",
          value:
            `\`${orderNumber}\``,
          inline: true
        },
        {
          name: "Currency",
          value:
            currency,
          inline: true
        },
        {
          name: "Billing",
          value: billingCycle === "yearly" ? "Yearly" : "Monthly",
          inline: true
        },
        {
          name:
            "Selected specifications",
          value:
            specsText(order),
          inline: false
        }
      )
      .setFooter({
        text:
          "The selected specifications cannot be changed during this order."
      })
      .setTimestamp();

  await interaction.editReply({
    content:
      `<@${user.id}>`,

    embeds: [embed],

    components: [
      buildBuyButton(
        orderNumber
      )
    ]
  });

  return true;
}

/* ============================================================
   ADMIN MESSAGE COMMANDS
============================================================ */

export async function handleBuyAdminMessage(
  message
) {
  /* ==========================================================
     CUSTOMER RECEIPT UPLOADS IN DM
  ========================================================== */
  if (!message.guildId && !message.author.bot) {
    const attachments = [...message.attachments.values()];
    if (!attachments.length) return false;

    const receiptItems = attachments.map(a => ({ url: a.url, name: a.name || 'receipt' }));
    const urls = receiptItems.map(a => a.url);
    const db = initFirebase();

    const ordersSnap = await db.ref("orders").once("value");
    const orders = Object.values(ordersSnap.val() || {});
    const order = orders
      .filter(o => o?.discordUserId === message.author.id && o?.status === "payment_selected" && !["paypal", "card"].includes(o?.paymentMethodKey))
      .sort((a,b) => String(b.paymentSelectedAt || b.createdAt).localeCompare(String(a.paymentSelectedAt || a.createdAt)))[0];

    if (order) {
      await updateOrder(order.orderNumber, {
        receiptUrls: urls,
        receiptUploadedAt: new Date().toISOString(),
        status: "receipt_uploaded"
      });
      const updated = { ...order, receiptUrls: urls, status: "receipt_uploaded" };
      try {
        await sendAdminVerificationAlert(message.client, updated, receiptItems.map((item,i) => ({ attachment: item.url, name: item.name || `receipt-${order.orderNumber}-${i+1}` })));
        await message.reply("✅ Receipt received and sent to the Aura Cloud verification team. Please wait for confirmation.");
      } catch (e) {
        await updateOrder(order.orderNumber, { status: "payment_selected" });
        console.error("Buy receipt forwarding failed:", e);
        await message.reply("❌ I received the receipt but could not send it to the verification team. Please try again.");
      }
      return true;
    }

    const renewSnap = await db.ref("renewals").once("value");
    const renewals = Object.values(renewSnap.val() || {});
    const renewal = renewals
      .filter(r => r?.discordUserId === message.author.id && r?.status === "payment_selected")
      .sort((a,b) => String(b.paymentSelectedAt || b.createdAt).localeCompare(String(a.paymentSelectedAt || a.createdAt)))[0];

    if (renewal) {
      await updateRenewalDb(renewal.renewalId, {
        receiptUrls: urls,
        receiptUploadedAt: new Date().toISOString(),
        status: "receipt_uploaded"
      });
      const updated = { ...renewal, receiptUrls: urls, status: "receipt_uploaded" };
      try {
        await sendRenewalVerificationAlert(message.client, updated, receiptItems.map((item,i) => ({ attachment: item.url, name: item.name || `receipt-${renewal.renewalId}-${i+1}` })));
        await message.reply("✅ Renewal receipt received and sent to the Aura Cloud verification team. Please wait for confirmation.");
      } catch (e) {
        await updateRenewalDb(renewal.renewalId, { status: "payment_selected" });
        console.error("Renewal receipt forwarding failed:", e);
        await message.reply("❌ I received the receipt but could not send it to the verification team. Please try again.");
      }
      return true;
    }

    return false;
  }

  if (
    !message.guildId ||
    message.author.bot
  ) {
    return false;
  }

  const raw =
    message.content.trim();

  const lower =
    raw.toLowerCase();

  /* ==========================================================
     !ADD OFFER
  ========================================================== */

  if (
    lower.startsWith(
      "!add offer"
    )
  ) {
    if (
      !isAdminMessage(
        message
      )
    ) {
      return false;
    }

    const args =
      raw
        .slice(
          "!add offer".length
        )
        .trim()
        .split(/\s+/);

    if (
      args.length < 3
    ) {
      await message.reply(
        "Usage: `!add offer CODE 20% 30 days` or `!add offer CODE 500 2027/7/1`"
      );

      return true;
    }

    const code =
      normalizeCode(
        args[0]
      );

    const value =
      parseDiscountValue(
        args[1]
      );

    const expiryInput =
      args
        .slice(2)
        .join(" ");

    const expiresAt =
      parseDuration(
        expiryInput
      );

    if (
      !code ||
      !value ||
      !expiresAt
    ) {
      await message.reply(
        "❌ Invalid offer. Examples: `!add offer SUMMER20 20% 30 days`, `!add offer SAVE500 500 2027/7/1`."
      );

      return true;
    }

    const coupon = {
      code,

      ...value,

      active:
        true,

      createdAt:
        new Date().toISOString(),

      createdBy:
        message.author.id,

      expiresAt
    };

    await saveDiscountCode(
      code,
      coupon
    );

    await message.reply(
      `✅ Offer **${code}** created.\n` +
      `Discount: **${
        value.type === "percent"
          ? `${value.value}%`
          : `LKR ${value.value.toLocaleString()}`
      }**\n` +
      `Expires: **${new Date(
        expiresAt
      ).toLocaleString()}**`
    );

    return true;
  }

  /* ==========================================================
     !CONFIRM
  ========================================================== */

  if (
    lower.startsWith(
      "!confirm"
    )
  ) {
    if (
      !isAdminMessage(
        message
      )
    ) {
      return false;
    }

    const args =
      raw.split(/\s+/);

    if (
      args.length < 2
    ) {
      await message.reply(
        "Usage: `!confirm ORDER-NUMBER`\n\n" +
        "The invoice number is generated automatically."
      );

      return true;
    }

    const orderNumber =
      args[1];

    try {
      const result =
        await finalizeOrder(
          orderNumber,
          message.author,
          null,
          message.client
        );

      if (
        result.alreadyConfirmed
      ) {
        await message.reply(
          `ℹ️ This order is already confirmed with invoice **${result.invoiceNumber}**.`
        );

        return true;
      }

      const currency =
        currencyOf(
          result.order
        );

      await message.reply({
        content:
          `✅ **Order confirmed**\n\n` +
          `Order: **${orderNumber}**\n` +
          `Invoice: **${result.invoiceNumber}**\n` +
          `Customer: <@${result.order.discordUserId}>\n` +
          `Payment: **${result.order.paymentMethod || "Unknown"}**\n` +
          `Total: **${formatMoney(
            result.order.total,
            currency
          )}**\n\n` +
          `Saved to Firebase and Google Sheets. Invoice generated.` +
          (
            result.emailSent
              ? " Invoice emailed to the customer."
              : " Invoice email failed."
          ) +
          (
            result.discordDmSent
              ? " Invoice also sent by Discord DM."
              : ""
          ),

        files: [
          new AttachmentBuilder(
            result.pdfPath,
            {
              name:
                `${result.invoiceNumber}.pdf`
            }
          )
        ]
      });
    } catch (error) {
      console.error(
        "!confirm failed:",
        error
      );

      await message.reply(
        `❌ Could not confirm **${orderNumber}**: ${error.message}`
      );
    }

    return true;
  }

  return false;
}