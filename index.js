import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  Events,
  EmbedBuilder
} from "discord.js";

import crypto from "crypto";

import {
  extractTransaction,
  extractInvoiceData,
  askAI
} from "./services/ai.js";

import {
  initFirebase,
  saveTransaction,
  saveInvoice,
  getInvoice,
  getNextInvoiceNumber
} from "./services/firebase.js";

import {
  addTransaction,
  addInvoice,
  getAllInvoices as getSheetInvoices,
  getAllTransactions as getSheetTransactions,
  searchInvoices as searchSheetInvoices,
  setupGoogleSheets
} from "./services/googleSheets.js";

import {
  calculateInvoice,
  createInvoiceFiles
} from "./services/invoice.js";

import {
  sendInvoiceEmail,
  sendMessageEmail
} from "./services/email.js";

import {
  handleBuyInteraction,
  handleBuySlashCommand,
  handleRenewSlashCommand,
  handleBuyAdminMessage,
  registerBuyCommand,
  checkServiceExpirations,
  startPayPalCallbackServer,
  handleDeliveryReaction,
  handleDiscountAddCommand,
  cleanupExpiredDiscountCodes
} from "./services/payments.js";

/* ============================================================
   DISCORD BOT
============================================================ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction,
    Partials.User
  ]
});

/* ============================================================
   TEMPORARY INVOICE STORAGE
============================================================ */

const pendingInvoices = new Map();

function invoiceDraftContent(draft) {
  const currency = draft.currency || "LKR";
  const totals = calculateInvoice({
    quantity: draft.quantity ?? 1,
    unitPrice: draft.unitPrice ?? 0,
    discount: draft.discount ?? 0,
    tax: draft.tax ?? 0
  });
  return `# 📄 Invoice Draft

**Description:** ${draft.description || "Not specified"}

**Quantity:** ${draft.quantity || 1}

**Unit Price:** ${currency} ${Number(draft.unitPrice ?? 0).toLocaleString()}

**Discount:** ${currency} ${Number(draft.discount ?? 0).toLocaleString()}

**Total After Discount:** ${currency} ${Number(totals.total ?? 0).toLocaleString()}

**Billing Cycle:** ${draft.billingCycle || "Monthly"}

**Status:** ${draft.status === "Paid" ? "Paid" : "Not Paid"}

**Purchase Date:** ${draft.purchaseDate || "Not specified"}

**Currency:** ${currency}

Choose the currency, billing cycle, and payment status below. LKR is the default. Any discount detected in the `!inv` message is included above.`;
}

function applyExplicitInvoiceAmounts(extracted, explanation) {
  const text = String(explanation || "");
  const amountPattern = String.raw`([\\d,]+(?:\\.\\d{1,2})?)`;

  // Explicit amounts in the command take priority over AI guesses.
  // Example: "Ranuga bought unlimited data 3 user V2Ray for 350 LKR, discount was 150 LKR".
  const priceMatch = text.match(new RegExp(
    String.raw`\\b(?:for|price(?:d)?(?:\\s+at)?|cost(?:s)?(?:\\s+of)?)\\s*(?:(?:LKR|Rs\\.?|USD|\\$)\\s*)?${amountPattern}\\s*(?:LKR|Rs\\.?|USD|\\$)?\\b`,
    "i"
  ));
  const discountMatch = text.match(new RegExp(
    String.raw`\\bdiscount(?:\\s+(?:was|is|of))?\\s*[:=]?\\s*(?:(?:LKR|Rs\\.?|USD|\\$)\\s*)?${amountPattern}\\s*(?:LKR|Rs\\.?|USD|\\$)?\\b`,
    "i"
  ));

  if (priceMatch) {
    extracted.unitPrice = Number(priceMatch[1].replace(/,/g, ""));
  }
  if (discountMatch) {
    extracted.discount = Number(discountMatch[1].replace(/,/g, ""));
  } else if (extracted.discount == null) {
    extracted.discount = 0;
  }

  let description = text;
  description = description.replace(new RegExp(
    String.raw`\\bdiscount(?:\\s+(?:was|is|of))?\\s*[:=]?\\s*(?:(?:LKR|Rs\\.?|USD|\\$)\\s*)?${amountPattern}\\s*(?:LKR|Rs\\.?|USD|\\$)?\\b`,
    "ig"
  ), " ");
  description = description.replace(new RegExp(
    String.raw`\\b(?:for|price(?:d)?(?:\\s+at)?|cost(?:s)?(?:\\s+of)?)\\s*(?:(?:LKR|Rs\\.?|USD|\\$)\\s*)?${amountPattern}\\s*(?:LKR|Rs\\.?|USD|\\$)?\\b`,
    "ig"
  ), " ");
  description = description
    .replace(/\\b(?:LKR|Rs\\.?|USD)\\s*[\\d,]+(?:\\.\\d{1,2})?\\b/gi, " ")
    .replace(/\\s+([,.])/g, "$1")
    .replace(/[\\s,;:.-]+$/g, "")
    .replace(/\\s{2,}/g, " ")
    .trim();

  // Keep the purchased service as the line description, not the buyer or payment wording.
  const boughtMatch = description.match(/^.+?\\s+bought\\s+(.+)$/i);
  if (boughtMatch) description = boughtMatch[1].trim();
  if (description) {
    extracted.description = description.charAt(0).toUpperCase() + description.slice(1);
  }
  return extracted;
}

function invoiceDraftComponents(pendingId, draft) {
  const currencyMenu = new StringSelectMenuBuilder()
    .setCustomId(`invoice_setting:${pendingId}:currency`)
    .setPlaceholder("Currency (default: LKR)")
    .addOptions(
      { label: "LKR — Sri Lankan Rupees", value: "LKR", default: (draft.currency || "LKR") === "LKR" },
      { label: "USD — US Dollars", value: "USD", default: draft.currency === "USD" }
    );
  const cycleMenu = new StringSelectMenuBuilder()
    .setCustomId(`invoice_setting:${pendingId}:billingCycle`)
    .setPlaceholder("Billing cycle (default: Monthly)")
    .addOptions(
      { label: "Monthly", value: "Monthly", default: (draft.billingCycle || "Monthly") === "Monthly" },
      { label: "Yearly", value: "Yearly", default: draft.billingCycle === "Yearly" },
      { label: "One-time", value: "One-time", default: draft.billingCycle === "One-time" }
    );
  const statusMenu = new StringSelectMenuBuilder()
    .setCustomId(`invoice_setting:${pendingId}:status`)
    .setPlaceholder("Payment status (default: Not Paid)")
    .addOptions(
      { label: "Not Paid", value: "Not Paid", default: draft.status !== "Paid" },
      { label: "Paid", value: "Paid", default: draft.status === "Paid" }
    );
  const createButton = new ButtonBuilder()
    .setCustomId(`create_invoice:${pendingId}`)
    .setLabel("Create Invoice")
    .setStyle(ButtonStyle.Primary);
  return [
    new ActionRowBuilder().addComponents(currencyMenu),
    new ActionRowBuilder().addComponents(cycleMenu),
    new ActionRowBuilder().addComponents(statusMenu),
    new ActionRowBuilder().addComponents(createButton)
  ];
}

/* ============================================================
   SECURITY
============================================================ */

function isAllowed(message) {
  if (
    message.guildId !== process.env.ALLOWED_GUILD_ID
  ) {
    return false;
  }

  if (
    message.channelId !== process.env.ALLOWED_CHANNEL_ID
  ) {
    return false;
  }

  if (!message.member) {
    return false;
  }

  if (
    !message.member.roles.cache.has(
      process.env.ALLOWED_ROLE_ID
    )
  ) {
    return false;
  }

  return true;
}

/* ============================================================
   ID
============================================================ */

function makeId() {
  return crypto.randomUUID();
}

/* ============================================================
   DATE HELPERS
============================================================ */

function dateToday() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function formatDate(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

function extractExplicitDate(text) {
  if (!text) {
    return null;
  }

  const match = text.match(
    /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/
  );

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(
    Date.UTC(
      year,
      month - 1,
      day
    )
  );

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return formatDate(date);
}

function detectRelativeDate(text) {
  if (!text) {
    return null;
  }

  const lower = text.toLowerCase();

  const today = new Date();

  if (/\btoday\b/.test(lower)) {
    return formatDate(today);
  }

  if (/\byesterday\b/.test(lower)) {
    const date = new Date(today);

    date.setDate(
      date.getDate() - 1
    );

    return formatDate(date);
  }

  if (/\btomorrow\b/.test(lower)) {
    const date = new Date(today);

    date.setDate(
      date.getDate() + 1
    );

    return formatDate(date);
  }

  return null;
}

function resolveDate(
  originalText,
  aiDate = null
) {
  const explicitDate =
    extractExplicitDate(
      originalText
    );

  if (explicitDate) {
    return explicitDate;
  }

  const relativeDate =
    detectRelativeDate(
      originalText
    );

  if (relativeDate) {
    return relativeDate;
  }

  if (
    aiDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(
      aiDate
    )
  ) {
    return aiDate;
  }

  return dateToday();
}

function safeDate(
  value,
  originalText = ""
) {
  return resolveDate(
    originalText,
    value
  );
}

/* ============================================================
   COMPANY FINANCIAL SUMMARY
============================================================ */

async function companySummary() {
  const [
    transactions,
    invoices
  ] = await Promise.all([
    getSheetTransactions(),
    getSheetInvoices()
  ]);

  const paid = value =>
    String(value || "")
      .trim()
      .toLowerCase() === "paid";

  const income =
    transactions
      .filter(
        t =>
          String(
            t.type || ""
          ).toLowerCase() ===
            "income" &&
          paid(t.status)
      )
      .reduce(
        (sum, t) =>
          sum +
          Number(
            t.amount || 0
          ),
        0
      );

  const expenses =
    transactions
      .filter(
        t =>
          String(
            t.type || ""
          ).toLowerCase() ===
            "expense" &&
          paid(t.status)
      )
      .reduce(
        (sum, t) =>
          sum +
          Number(
            t.amount || 0
          ),
        0
      );

  const invoiceRevenue =
    invoices
      .filter(i =>
        paid(i.status)
      )
      .reduce(
        (sum, i) =>
          sum +
          Number(
            i.total || 0
          ),
        0
      );

  return {
    source: "Google Sheets",

    totalTransactions:
      transactions.length,

    totalInvoices:
      invoices.length,

    recordedIncome:
      income,

    recordedExpenses:
      expenses,

    recordedProfit:
      income - expenses,

    paidInvoiceRevenue:
      invoiceRevenue,

    transactions:
      transactions.slice(-100),

    invoices:
      invoices.slice(-100)
  };
}

/* ============================================================
   CUSTOMER SEARCH
============================================================ */

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}

async function getAllInvoices() {
  return getSheetInvoices();
}

async function findCustomersInQuestion(
  question
) {
  const invoices =
    await getAllInvoices();

  const questionNormalized =
    normalizeSearchText(
      question
    );

  const customers = [];

  for (
    const invoice of invoices
  ) {
    const name =
      invoice.customer?.name ||
      invoice.clientName ||
      invoice.customerName ||
      "";

    if (!name) {
      continue;
    }

    const normalizedName =
      normalizeSearchText(
        name
      );

    if (!normalizedName) {
      continue;
    }

    if (
      questionNormalized.includes(
        normalizedName
      )
    ) {
      const alreadyExists =
        customers.some(
          customer =>
            normalizeSearchText(
              customer.name
            ) === normalizedName
        );

      if (!alreadyExists) {
        customers.push({
          name,
          invoices: []
        });
      }
    }
  }

  for (
    const customer of customers
  ) {
    const normalizedName =
      normalizeSearchText(
        customer.name
      );

    customer.invoices =
      invoices.filter(
        invoice => {
          const invoiceName =
            invoice.customer?.name ||
            invoice.clientName ||
            invoice.customerName ||
            "";

          return (
            normalizeSearchText(
              invoiceName
            ) === normalizedName
          );
        }
      );
  }

  return customers;
}

/* ============================================================
   CUSTOMER ANALYSIS
============================================================ */

function createCustomerAnalysis(
  customer
) {
  const invoices =
    customer.invoices || [];

  const minecraftInvoices =
    invoices.filter(
      invoice => {
        const description =
          String(
            invoice.description || ""
          ).toLowerCase();

        const service =
          String(
            invoice.service || ""
          ).toLowerCase();

        const combined =
          `${description} ${service}`;

        return combined.includes(
          "minecraft"
        );
      }
    );

  const unpaidMinecraftInvoices =
    minecraftInvoices.filter(
      invoice => {
        const status =
          String(
            invoice.status || ""
          )
            .trim()
            .toLowerCase();

        return (
          status === "unpaid" ||
          status === "pending"
        );
      }
    );

  const unpaidMinecraftValue =
    unpaidMinecraftInvoices.reduce(
      (
        total,
        invoice
      ) => {
        const quantity =
          Math.max(
            1,
            Number(
              invoice.quantity ?? 1
            )
          );

        const unitPrice =
          Number(
            invoice.unitPrice ?? 0
          );

        const invoiceTotal =
          Number(
            invoice.total ?? 0
          );

        const value =
          invoiceTotal > 0
            ? invoiceTotal
            : quantity * unitPrice;

        return total + value;
      },
      0
    );

  const unpaidInvoices =
    invoices.filter(
      invoice => {
        const status =
          String(
            invoice.status || ""
          )
            .trim()
            .toLowerCase();

        return (
          status === "unpaid" ||
          status === "pending"
        );
      }
    );

  const totalOutstanding =
    unpaidInvoices.reduce(
      (
        total,
        invoice
      ) => {
        const totalValue =
          Number(
            invoice.total ?? 0
          );

        if (totalValue > 0) {
          return total + totalValue;
        }

        const quantity =
          Math.max(
            1,
            Number(
              invoice.quantity ?? 1
            )
          );

        const unitPrice =
          Number(
            invoice.unitPrice ?? 0
          );

        return (
          total +
          quantity * unitPrice
        );
      },
      0
    );

  const records =
    invoices.map(
      invoice => ({
        invoiceNumber:
          invoice.invoiceNumber ||
          null,

        customer:
          invoice.customer?.name ||
          invoice.clientName ||
          invoice.customerName ||
          null,

        description:
          invoice.description ||
          "",

        service:
          invoice.service ||
          "",

        quantity:
          invoice.quantity ??
          1,

        billingCycle:
          invoice.billingCycle ||
          "",

        unitPrice:
          invoice.unitPrice ??
          0,

        discount:
          invoice.discount ??
          0,

        tax:
          invoice.tax ??
          0,

        total:
          invoice.total ??
          0,

        currency:
          invoice.currency ||
          "LKR",

        status:
          invoice.status ||
          "",

        purchaseDate:
          invoice.purchaseDate ||
          "",

        expiryDate:
          invoice.expiryDate ||
          "",

        createdAt:
          invoice.createdAt ||
          ""
      })
    );

  return {
    customerName:
      customer.name,

    totalInvoices:
      invoices.length,

    minecraftServerInvoices:
      minecraftInvoices.length,

    unpaidMinecraftServers:
      unpaidMinecraftInvoices.length,

    unpaidMinecraftValue,

    totalUnpaidInvoices:
      unpaidInvoices.length,

    totalOutstanding,

    currency:
      unpaidMinecraftInvoices[0]
        ?.currency ||
      invoices[0]?.currency ||
      "LKR",

    invoices:
      records,

    minecraftInvoices:
      minecraftInvoices.map(
        invoice => ({
          invoiceNumber:
            invoice.invoiceNumber ||
            null,

          description:
            invoice.description ||
            "",

          service:
            invoice.service ||
            "",

          quantity:
            invoice.quantity ??
            1,

          unitPrice:
            invoice.unitPrice ??
            0,

          total:
            invoice.total ??
            0,

          currency:
            invoice.currency ||
            "LKR",

          status:
            invoice.status ||
            "",

          purchaseDate:
            invoice.purchaseDate ||
            "",

          expiryDate:
            invoice.expiryDate ||
            ""
        })
      ),

    unpaidMinecraftInvoices:
      unpaidMinecraftInvoices.map(
        invoice => ({
          invoiceNumber:
            invoice.invoiceNumber ||
            null,

          description:
            invoice.description ||
            "",

          service:
            invoice.service ||
            "",

          quantity:
            invoice.quantity ??
            1,

          unitPrice:
            invoice.unitPrice ??
            0,

          total:
            invoice.total ??
            0,

          currency:
            invoice.currency ||
            "LKR",

          status:
            invoice.status ||
            "",

          purchaseDate:
            invoice.purchaseDate ||
            "",

          expiryDate:
            invoice.expiryDate ||
            ""
        })
      )
  };
}

/* ============================================================
   LOCAL CUSTOMER ANSWER
============================================================ */

function localCustomerAnswer(
  analysis,
  question
) {
  const {
    customerName,
    unpaidMinecraftServers,
    unpaidMinecraftValue,
    totalInvoices,
    totalUnpaidInvoices,
    totalOutstanding,
    currency,
    unpaidMinecraftInvoices
  } = analysis;

  const lower =
    question.toLowerCase();

  if (
    lower.includes("minecraft") &&
    (
      lower.includes("non-paid") ||
      lower.includes("non paid") ||
      lower.includes("unpaid") ||
      lower.includes("not paid") ||
      lower.includes("how many") ||
      lower.includes("quantity") ||
      lower.includes("worth")
    )
  ) {
    if (
      unpaidMinecraftServers === 0
    ) {
      return [
        `**No unpaid Minecraft server records were found for ${customerName}.**`,
        "",
        `Based on the verified Aura Cloud invoice records, there are **0 unpaid Minecraft servers** for this customer.`,
        "",
        `**Total invoices checked:** ${totalInvoices}`
      ].join("\n");
    }

    const invoiceLines =
      unpaidMinecraftInvoices.map(
        invoice => {
          const quantity =
            Math.max(
              1,
              Number(
                invoice.quantity ?? 1
              )
            );

          const unitPrice =
            Number(
              invoice.unitPrice ?? 0
            );

          const invoiceTotal =
            Number(
              invoice.total ?? 0
            );

          const value = (
            invoiceTotal > 0
              ? invoiceTotal
              : quantity * unitPrice
          ).toLocaleString();

          return [
            `**Invoice:** \`${invoice.invoiceNumber || "Unknown"}\``,
            `**Server:** ${invoice.description || invoice.service || "Minecraft server"}`,
            `**Quantity:** ${invoice.quantity ?? 1}`,
            `**Value:** ${value} ${invoice.currency || currency}`,
            `**Status:** ${invoice.status}`
          ].join("\n");
        }
      );

    return [
      `# 📊 Unpaid Minecraft Server — ${customerName}`,
      "",
      "Based on Aura Cloud's verified invoice records:",
      "",
      `**Quantity of unpaid Minecraft servers:** ${unpaidMinecraftServers}`,
      `**Recorded outstanding value:** ${unpaidMinecraftValue.toLocaleString()} ${currency}`,
      "",
      ...invoiceLines,
      "",
      "**Note:** The value above is the amount recorded in Aura Cloud's invoices. It is not an independent market valuation."
    ].join("\n");
  }

  if (
    lower.includes("unpaid") ||
    lower.includes("outstanding") ||
    lower.includes("owe") ||
    lower.includes("payment")
  ) {
    return [
      `# 📊 ${customerName} — Payment Status`,
      "",
      `**Total invoices:** ${totalInvoices}`,
      `**Unpaid/Pending invoices:** ${totalUnpaidInvoices}`,
      `**Total outstanding:** ${totalOutstanding.toLocaleString()} ${currency}`,
      "",
      "These figures are calculated from the verified invoice records."
    ].join("\n");
  }

  return [
    `# 📊 ${customerName}`,
    "",
    `**Total invoices:** ${totalInvoices}`,
    `**Unpaid/Pending invoices:** ${totalUnpaidInvoices}`,
    `**Outstanding amount:** ${totalOutstanding.toLocaleString()} ${currency}`,
    `**Unpaid Minecraft servers:** ${unpaidMinecraftServers}`,
    `**Unpaid Minecraft value:** ${unpaidMinecraftValue.toLocaleString()} ${currency}`,
    "",
    "These figures are based only on the customer's recorded Aura Cloud invoices."
  ].join("\n");
}

/* ============================================================
   AI RESPONSE FORMATTER
============================================================ */

function formatAIResponse(text) {
  if (!text) {
    return "";
  }

  let result =
    String(text)
      .replace(/\r/g, "")
      .replace(/```(?:markdown)?/gi, "")
      .replace(/```/g, "")
      .replace(/^\s*[*_\\]*[-•]\s+/gm, "")
      .replace(/^\s*[*_\\]*_{3,}\s+/gm, "")
      .trim();

  result =
    result
      .replace(
        /^\s*\*#{4,}\s*/gm,
        "### "
      )
      .replace(
        /\n{3,}/g,
        "\n\n"
      );

  return result;
}

async function cleanAndReply(
  message,
  text
) {
  const formatted =
    formatAIResponse(text);

  if (!formatted) {
    return message.reply(
      "No analysis was returned."
    );
  }

  /*
   * Discord messages have a 2000-character limit.
   * Split long AI responses automatically.
   */
  if (formatted.length <= 2000) {
    return message.reply(
      formatted
    );
  }

  const chunks = [];

  for (
    let i = 0;
    i < formatted.length;
    i += 1900
  ) {
    chunks.push(
      formatted.slice(
        i,
        i + 1900
      )
    );
  }

  await message.reply(
    chunks.shift()
  );

  for (const chunk of chunks) {
    await message.channel.send(
      chunk
    );
  }
}

/* ============================================================
   DELIVERY TASK REACTIONS
============================================================ */

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await handleDeliveryReaction(reaction, user);
  } catch (error) {
    console.error("Delivery reaction event failed:", error);
  }
});

/* ============================================================
   BOT READY
============================================================ */

client.once(
  Events.ClientReady,
  async () => {
    try {
      await initFirebase();
      try {
        await setupGoogleSheets();
        console.log("Google Sheets tabs checked/created.");
      } catch (sheetError) {
        console.error("Google Sheets setup did not complete. Check GOOGLE_SERVICE_ACCOUNT_FILE and GOOGLE_SHEET_ID:", sheetError.message);
      }

      console.log(
        `Aura Cloud Manager Bot online as ${client.user.tag}`
      );

      console.log(
        "Firebase Realtime Database initialized."
      );

      await registerBuyCommand(
        client
      );
      try {
        const removed = await cleanupExpiredDiscountCodes();
        console.log(`Expired discount codes cleaned up: ${removed}`);
        setInterval(() => cleanupExpiredDiscountCodes().catch(error => console.error("Discount cleanup failed:", error)), 5 * 60 * 1000);
      } catch (discountCleanupError) {
        console.error("Discount cleanup could not run:", discountCleanupError.message);
      }

      console.log(
        "Buy command registered."
      );

      // Check service expiry reminders every 5 minutes.
      // Notifications are marked in Firebase so users do not receive duplicates.
      const runExpiryCheck = async () => {
        try {
          await checkServiceExpirations(client);
        } catch (error) {
          console.error("Service expiry checker failed:", error);
        }
      };

      await runExpiryCheck();
      setInterval(runExpiryCheck, 5 * 60 * 1000);
    } catch (error) {
      console.error(
        "Firebase startup error:",
        error
      );
    }
  }
);

/* ============================================================
   MESSAGE COMMANDS
============================================================ */

client.on(
  Events.MessageCreate,
  async message => {
    try {
      /* Ignore bots */
      if (
        message.author.bot
      ) {
        return;
      }

      /* ======================================================
         PAYMENT ADMIN HANDLER
      ====================================================== */

      if (
        await handleBuyAdminMessage(
          message
        )
      ) {
        return;
      }

      /* ======================================================
         HELP
      ====================================================== */

      if (
        message.content
          .trim()
          .toLowerCase() ===
        "!help"
      ) {
        const helpEmbed =
          new EmbedBuilder()
            .setTitle(
              "🤖 Aura Cloud Manager Bot"
            )
            .setDescription(
              "Management and accounting commands for Aura Cloud Hosting."
            )
            .addFields(
              {
                name:
                  "🛒 /buy — Create Hosting Order",

                value:
                  "`/buy user:@user ram:4GB disk:50GB cpu:2vCore location:Singapore price:1500`\n\n" +
                  "The customer receives a public order message, verifies their email by OTP, selects payment, and waits for admin confirmation."
              },

              {
                name:
                  "🎟️ /discountadd — Create Discount Code",

                value:
                  "`/discountadd type:buy discount:20% expiry:30d code:WELCOME20`\n" +
                  "Types: buy, renew, or one-per-account (both). Each account can use a code once."
              },

              {
                name:
                  "✅ !confirm — Confirm Order",

                value:
                  "`!confirm AURA-ORDER-2026-000001 AURA-2026-000123`"
              },

              {
                name:
                  "💰 !in — Record Transaction",

                value:
                  "`!in <explanation>`\n\n" +
                  "Example:\n" +
                  "`!in Client paid 21000 LKR on 2026-08-20 for VPS hosting by bank transfer`"
              },

              {
                name:
                  "📄 !inv — Create Invoice",

                value:
                  "`!inv <explanation>`\n\n" +
                  "Example:\n" +
                  "`!inv Client purchased Minecraft hosting for 5000 LKR monthly and paid today`"
              },

              {
                name:
                  "📤 !ap — Send Invoice",

                value:
                  "`!ap @user <invoice-number>`\n\n" +
                  "or\n\n" +
                  "`!ap email@example.com <invoice-number>`\n\n" +
                  "Example:\n" +
                  "`!ap @Client AURA-2026-000001`"
              },

              {
                name:
                  "💬 !msg — Message a Discord User",

                value:
                  "`!msg @user <message>`\n\n" +
                  "or\n\n" +
                  "`!msg USER_ID <message>`\n\n" +
                  "The message can contain spaces, line breaks, mentions, emojis, Markdown and special characters. Formatting is preserved."
              },

              {
                name:
                  "📧 !email — Send Email",

                value:
                  "`!email email@example.com <message>`\n\n" +
                  "Example:\n" +
                  "`!email client@example.com Your invoice is ready.`"
              },

              {
                name:
                  "📊 !tell — Ask Aura AI",

                value:
                  "`!tell <question>`\n\n" +
                  "Examples:\n\n" +
                  "`!tell What is the company status?`\n" +
                  "`!tell How much revenue do we have?`\n" +
                  "`!tell How many unpaid Minecraft servers does pixelDreamescapes have?`\n" +
                  "`!tell What does pixelDreamescapes owe us?`\n" +
                  "`!tell Explain order AURA-2026-000001`"
              }
            )
            .setFooter({
              text:
                "Management commands require the authorized Aura Cloud role."
            })
            .setTimestamp();

        await message.reply({
          embeds: [
            helpEmbed
          ]
        });

        return;
      }

      /* ======================================================
         SECURITY
      ====================================================== */

      // Do not silently ignore accounting commands when a server, channel,
      // or role restriction is mismatched. Explain the exact missing access.
      const accessCommand = message.content.trim().match(/^!(in|inv|ap)\b/i);
      if (!isAllowed(message)) {
        if (accessCommand) {
          let reason = "This command is restricted.";
          if (message.guildId !== process.env.ALLOWED_GUILD_ID) {
            reason = "Wrong server: use the configured Aura Cloud Discord server.";
          } else if (message.channelId !== process.env.ALLOWED_CHANNEL_ID) {
            reason = "Wrong channel: use the accounting channel configured in the bot's .env file.";
          } else if (!message.member) {
            reason = "I could not verify your server membership. Try the command in a server channel.";
          } else if (!process.env.ALLOWED_ROLE_ID) {
            reason = "Bot setup issue: ALLOWED_ROLE_ID is missing from .env.";
          } else if (!message.member.roles.cache.has(process.env.ALLOWED_ROLE_ID)) {
            reason = "Missing role: you need the role configured by ALLOWED_ROLE_ID in the bot's .env file.";
          }
          await message.reply(`🔒 ${reason}`);
        }
        return;
      }

      /*
       * Keep the ORIGINAL Discord message.
       *
       * Do not use trim(), split(/\s+/), or join(" ")
       * for !msg because those destroy formatting.
       */

      const rawContent =
        message.content;

      const content =
        rawContent.trim();

      /* ======================================================
         !in
         RECORD TRANSACTION
      ====================================================== */

      if (
        content === "!in" ||
        content.startsWith(
          "!in "
        )
      ) {
        const explanation =
          content
            .slice(3)
            .trim();

        if (!explanation) {
          return message.reply(
            "❌ Please explain the transaction after `!in`."
          );
        }

        try {
          await message.channel.send(
            "🤖 Aura AI is processing the transaction..."
          );

          const extracted =
            await extractTransaction(
              explanation
            );

          if (
            extracted.amount ===
              null ||
            extracted.amount ===
              undefined ||
            Number.isNaN(
              Number(
                extracted.amount
              )
            )
          ) {
            return message.reply(
              "❌ I could not identify the transaction amount. Please include the amount clearly."
            );
          }

          const transactionDate =
            resolveDate(
              explanation,
              extracted.date
            );

          const transaction = {
            ...extracted,

            id:
              makeId(),

            createdAt:
              new Date().toISOString(),

            date:
              transactionDate,

            recordedBy: {
              userId:
                message.author.id,

              username:
                message.author.tag
            },

            originalExplanation:
              explanation
          };

          await Promise.all([
            saveTransaction(
              transaction.id,
              transaction
            ),

            addTransaction(
              transaction
            )
          ]);

          return message.reply(
            `# 💰 Transaction Added

**Transaction ID:** \`${transaction.id}\`

**Type:** ${transaction.type}

**Amount:** ${transaction.amount} ${transaction.currency || "LKR"}

**Service:** ${transaction.service || "Not specified"}

**Payment Method:** ${transaction.paymentMethod || "Not specified"}

**Status:** ${transaction.status || "unknown"}

**Transaction Date:** ${transactionDate}

**Created At:** ${transaction.createdAt}

✅ Saved to Firebase Realtime Database.

✅ Saved to Google Sheets.`
          );
        } catch (error) {
          console.error(
            "Transaction error:",
            error
          );

          return message.reply(
            `❌ Transaction failed: ${error.message}`
          );
        }
      }

      /* ======================================================
         !inv
         CREATE INVOICE
      ====================================================== */

      if (
        content === "!inv" ||
        content.startsWith(
          "!inv "
        )
      ) {
        const explanation =
          content
            .slice(4)
            .trim();

        if (!explanation) {
          return message.reply(
            "❌ Please explain the invoice after `!inv`."
          );
        }

        try {
          await message.channel.send(
            "🤖 Aura AI is preparing the invoice draft..."
          );

          const extracted =
            await extractInvoiceData(
              explanation
            );

          applyExplicitInvoiceAmounts(extracted, explanation);

          extracted.purchaseDate =
            resolveDate(
              explanation,
              extracted.purchaseDate
            );

          const pendingId =
            makeId();

          pendingInvoices.set(
            pendingId,
            {
              ...extracted,

              originalExplanation:
                explanation,

              requestedBy:
                message.author.id,

              createdAt:
                Date.now()
            }
          );

          return message.reply({
            content: invoiceDraftContent(pendingInvoices.get(pendingId)),
            components: invoiceDraftComponents(pendingId, pendingInvoices.get(pendingId))
          });
        } catch (error) {
          console.error("Invoice draft error:", error);
          return message.reply(`❌ Invoice draft failed: ${error.message}`);
        }
      }

      /* ======================================================
         !ap
         SEND INVOICE
      ====================================================== */

      if (
        content === "!ap" ||
        content.startsWith(
          "!ap "
        )
      ) {
        const parts =
          content.split(
            /\s+/
          );

        if (
          parts.length < 3
        ) {
          return message.reply(
            "❌ Usage: `!ap @user AURA-2026-000001` or `!ap email@example.com AURA-2026-000001`"
          );
        }

        const target =
          parts[1];

        const invoiceNumber =
          parts[2].toUpperCase();

        const pendingRef = initFirebase().ref(`pendingInvoiceApprovals/${invoiceNumber}`);
        const pendingSnapshot = await pendingRef.once("value");
        const pendingInvoice = pendingSnapshot.val();

        if (pendingInvoice) {
          try {
            const approvedInvoice = {
              ...pendingInvoice,
              status: "Approved",
              approvedAt: new Date().toISOString(),
              approvedBy: { userId: message.author.id, username: message.author.tag || message.author.username }
            };
            const { xlsxPath, pdfPath } = await createInvoiceFiles(approvedInvoice);
            approvedInvoice.xlsxPath = xlsxPath;
            approvedInvoice.pdfPath = pdfPath;
            await Promise.all([
              saveInvoice(invoiceNumber, approvedInvoice),
              addInvoice(approvedInvoice),
              pendingRef.remove()
            ]);
            const targetUser = message.mentions.users.first();
            if (targetUser) {
              try {
                await targetUser.send({
                  content: `# Aura Cloud Hosting Invoice\n\nInvoice Number: **${invoiceNumber}**\nClient: **${approvedInvoice.customer?.name || "Customer"}**\nTotal: **${approvedInvoice.currency || "LKR"} ${Number(approvedInvoice.total || 0).toLocaleString()}**\n\nYour invoice has been approved. Please find the official PDF attached.`,
                  files: [new AttachmentBuilder(pdfPath, { name: `${invoiceNumber}.pdf` })]
                });
              } catch (dmError) {
                await message.reply(`⚠️ Invoice approved and recorded, but I could not DM ${targetUser.tag}. The PDF is attached here for manual delivery.`);
                return message.channel.send({ files: [new AttachmentBuilder(pdfPath, { name: `${invoiceNumber}.pdf` })] });
              }
            }
            return message.reply(`✅ Invoice **${invoiceNumber}** approved and recorded in Firebase and Google Sheets.${targetUser ? ` Official PDF sent to ${targetUser.tag}.` : " No Discord user was mentioned, so the invoice was recorded but not DM-delivered."}`);
          } catch (approvalError) {
            console.error("Invoice approval failed:", approvalError);
            return message.reply(`❌ Could not approve invoice: ${approvalError.message}`);
          }
        }

        const invoice =
          await getInvoice(
            invoiceNumber
          );

        if (!invoice) {
          return message.reply(
            "❌ Invoice not found."
          );
        }

        const pdfPath =
          invoice.pdfPath ||
          `./output/${invoiceNumber}.pdf`;

        try {
          /* Discord user */

          if (
            message.mentions.users.size
          ) {
            const user =
              message.mentions.users.first();

            await user.send({
              content:
                `# Aura Cloud Hosting Invoice

Invoice Number: **${invoiceNumber}**

Please find your invoice attached.`,

              files: [
                new AttachmentBuilder(
                  pdfPath
                )
              ]
            });

            return message.reply(
              `✅ Invoice sent to ${user.tag}.`
            );
          }

          /* Email */

          if (
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
              target
            )
          ) {
            await sendInvoiceEmail(
              target,
              invoiceNumber,
              pdfPath
            );

            return message.reply(
              `✅ Invoice emailed to ${target}.`
            );
          }

          return message.reply(
            "❌ Please mention a Discord user or provide a valid email address."
          );
        } catch (error) {
          console.error(
            "Invoice sending error:",
            error
          );

          return message.reply(
            `❌ Could not send invoice: ${error.message}`
          );
        }
      }

      /* ======================================================
         !msg — SEND DISCORD MESSAGE

         Supports:

         !msg @user hello

         !msg @user hello     bro

         !msg @user hello
         bro

         !msg @user @someone

         !msg USER_ID hello

         Everything after the target user is preserved.
      ====================================================== */

      if (
        /^!msg(?:[\s\t]+|$)/i.test(
          rawContent
        )
      ) {
        /*
         * Remove the command itself.
         *
         * We use the original message instead of
         * content.trim() so formatting is not destroyed.
         */

        let msgContent =
          rawContent.replace(
            /^!msg\b/i,
            ""
          );

        /*
         * Allow accidental/repeated !msg commands.
         *
         * Example:
         *
         * !msg !msg @user hello
         *
         * becomes:
         *
         * @user hello
         */

        while (
          /^\s*!msg\b/i.test(
            msgContent
          )
        ) {
          msgContent =
            msgContent.replace(
              /^\s*!msg\b/i,
              ""
            );
        }

        /*
         * Find the FIRST valid Discord mention or
         * numeric Discord user ID.
         *
         * Supported:
         *
         * <@123456789012345678>
         * <@!123456789012345678>
         * 123456789012345678
         */

        const targetMatch =
          msgContent.match(
            /^\s*(<@!?(\d{17,20})>|(\d{17,20}))([\s\S]*)$/i
          );

        if (
          !targetMatch
        ) {
          return message.reply(
            "❌ Usage: `!msg @user <message>` or `!msg USER_ID <message>`"
          );
        }

        /*
         * Discord ID from the target.
         */

        const targetId =
          targetMatch[2] ||
          targetMatch[3];

        /*
         * Everything after the target is kept.
         *
         * IMPORTANT:
         *
         * We DO NOT:
         *
         * - split()
         * - join()
         * - trim()
         * - collapse spaces
         * - remove new lines
         */

        let text =
          targetMatch[4];

        /*
         * The first whitespace character is only
         * the separator between the user and message.
         *
         * Remove that separator only.
         *
         * If the user intentionally puts multiple
         * spaces after the mention, the remaining
         * spaces are preserved.
         */

        if (
          text.startsWith(" ") ||
          text.startsWith("\t") ||
          text.startsWith("\r") ||
          text.startsWith("\n")
        ) {
          text =
            text.slice(1);
        }

        /*
         * Check that a message actually exists.
         *
         * Do NOT use text.trim() here because we want
         * to preserve the original message.
         */

        if (
          text.length === 0
        ) {
          return message.reply(
            "❌ Please provide a message to send."
          );
        }

        try {
          /*
           * Fetch the Discord user.
           */

          const user =
            await client.users.fetch(
              targetId
            );

          /*
           * Send EXACTLY what was written after
           * the target user.
           *
           * Discord Markdown, mentions, emojis,
           * line breaks, multiple spaces and
           * special characters are preserved.
           */

          await user.send({
            content: text
          });

          return message.reply(
            `✅ Message sent to **${user.tag}**.`
          );
        } catch (error) {
          console.error(
            "Discord message error:",
            error
          );

          return message.reply(
            `❌ Could not send the message: ${error.message}`
          );
        }
      }

      /* ======================================================
         !email
         SEND EMAIL
      ====================================================== */

      if (
        content === "!email" ||
        content.startsWith(
          "!email "
        )
      ) {
        const match =
          content.match(
            /^!email\s+(\S+)\s+([\s\S]+)$/i
          );

        if (!match) {
          return message.reply(
            "❌ Usage: `!email email@example.com <message>`"
          );
        }

        const emailAddress =
          match[1].trim();

        const emailMessage =
          match[2].trim();

        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            emailAddress
          )
        ) {
          return message.reply(
            "❌ Please provide a valid email address."
          );
        }

        try {
          await sendMessageEmail(
            emailAddress,
            emailMessage
          );

          return message.reply(
            `✅ Email sent to **${emailAddress}**.`
          );
        } catch (error) {
          console.error(
            "Email send error:",
            error
          );

          return message.reply(
            `❌ Could not send the email: ${error.message}`
          );
        }
      }

      /* ======================================================
         !tell
         AI / CUSTOMER / COMPANY ANALYSIS
      ====================================================== */

      if (
        content === "!tell" ||
        content.startsWith(
          "!tell "
        )
      ) {
        const question =
          content
            .slice(5)
            .trim();

        if (!question) {
          return message.reply(
            "❌ Please ask a question after `!tell`."
          );
        }

        try {
          /* ==================================================
             DIRECT INVOICE LOOKUP
          ================================================== */

          const orderMatch =
            question.match(
              /AURA-\d{4}-\d{6}/i
            );

          if (
            orderMatch
          ) {
            const invoiceNumber =
              orderMatch[0]
                .toUpperCase();

            const sheetMatches =
              await searchSheetInvoices(
                invoiceNumber
              );

            const invoice =
              sheetMatches.find(
                item =>
                  String(
                    item.invoiceNumber ||
                    ""
                  ).toUpperCase() ===
                  invoiceNumber
              );

            if (!invoice) {
              return message.reply(
                `❌ Order ${invoiceNumber} was not found.`
              );
            }

            try {
              const answer =
                await askAI(
                  `The company owner asked:

"${question}"

Here is the VERIFIED invoice record:

${JSON.stringify(
  invoice,
  null,
  2
)}

Answer using ONLY this invoice.

Include relevant:

- Customer information
- Service
- Price
- Payment status
- Dates
- Invoice total

Do not invent anything.`,

                  "You are the private AI manager for Aura Cloud Hosting. Only use verified invoice data."
                );

              return cleanAndReply(
                message,
                answer
              );
            } catch {
              return message.reply(
                [
                  `# 📄 Invoice ${invoiceNumber}`,
                  "",

                  `**Customer:** ${
                    invoice.customer?.name ||
                    invoice.clientName ||
                    "Not specified"
                  }`,

                  `**Description:** ${
                    invoice.description ||
                    "Not specified"
                  }`,

                  `**Quantity:** ${
                    invoice.quantity ??
                    1
                  }`,

                  `**Unit Price:** ${
                    invoice.unitPrice ??
                    0
                  } ${
                    invoice.currency ||
                    "LKR"
                  }`,

                  `**Total:** ${
                    invoice.total ??
                    0
                  } ${
                    invoice.currency ||
                    "LKR"
                  }`,

                  `**Status:** ${
                    invoice.status ||
                    "Unknown"
                  }`,

                  `**Purchase Date:** ${
                    invoice.purchaseDate ||
                    "Not specified"
                  }`,

                  `**Expiry Date:** ${
                    invoice.expiryDate ||
                    "Not specified"
                  }`
                ].join("\n")
              );
            }
          }

          /* ==================================================
             CUSTOMER LOOKUP
          ================================================== */

          const customers =
            await findCustomersInQuestion(
              question
            );

          if (
            customers.length >
            0
          ) {
            for (
              const customer of
              customers
            ) {
              const analysis =
                createCustomerAnalysis(
                  customer
                );

              const localAnswer =
                localCustomerAnswer(
                  analysis,
                  question
                );

              const lowerQuestion =
                question.toLowerCase();

              const isFactQuestion =
                lowerQuestion.includes(
                  "how many"
                ) ||
                lowerQuestion.includes(
                  "quantity"
                ) ||
                lowerQuestion.includes(
                  "unpaid"
                ) ||
                lowerQuestion.includes(
                  "non-paid"
                ) ||
                lowerQuestion.includes(
                  "non paid"
                ) ||
                lowerQuestion.includes(
                  "worth"
                ) ||
                lowerQuestion.includes(
                  "owe"
                ) ||
                lowerQuestion.includes(
                  "outstanding"
                );

              if (
                isFactQuestion
              ) {
                return message.reply(
                  localAnswer
                );
              }

              try {
                const answer =
                  await askAI(
                    `The company owner asked:

"${question}"

IMPORTANT:

This is a CUSTOMER-SPECIFIC question.

Customer:

${analysis.customerName}

Use ONLY the verified invoices below.

Do not use the company's overall financial totals.

Do not use other customers.

Do not invent servers, prices, payments, or services.

VERIFIED CUSTOMER DATA:

${JSON.stringify(
  analysis,
  null,
  2
)}

Answer the owner's question accurately.

If the question asks about Minecraft servers:

- Count only invoices whose description/service actually contains Minecraft.
- Do not count unrelated products as Minecraft servers.
- For unpaid servers, count only Minecraft invoices whose status is Unpaid or Pending.
- Use the invoice total/unit price from the actual record.
- Mention the invoice number when useful.

Clearly distinguish invoice value from market value.`,

                    "You are Aura Cloud Hosting's private customer-accounting AI. You MUST use only the supplied customer's verified records. Never invent information."
                  );

                return cleanAndReply(
                  message,
                  answer
                );
              } catch (
                aiError
              ) {
                console.error(
                  "Customer AI analysis unavailable:",
                  aiError.message
                );

                return message.reply(
                  localAnswer
                );
              }
            }
          }

          /* ==================================================
             COMPANY ANALYSIS
          ================================================== */

          const summary =
            await companySummary();

          try {
            const answer =
              await askAI(
                `The company owner asked:

"${question}"

Here is VERIFIED Aura Cloud accounting data:

${JSON.stringify(
  summary,
  null,
  2
)}

Analyze the company.

You can discuss:

- Revenue
- Expenses
- Profit
- Number of invoices
- Recent transactions
- Financial trends
- Business recommendations

Clearly separate verified facts from recommendations.

Never invent financial numbers.`,

                "You are the private AI business manager for Aura Cloud Hosting. Use only verified accounting data."
              );

            return cleanAndReply(
              message,
              answer
            );
          } catch (
            aiError
          ) {
            console.error(
              "AI company analysis unavailable:",
              aiError.message
            );

            const income =
              Number(
                summary.recordedIncome ||
                0
              );

            const expenses =
              Number(
                summary.recordedExpenses ||
                0
              );

            const profit =
              Number(
                summary.recordedProfit ??
                income - expenses
              );

            const paidInvoiceRevenue =
              Number(
                summary.paidInvoiceRevenue ||
                0
              );

            let performance =
              "There is not enough financial data to determine the company's overall performance.";

            if (
              income > 0 &&
              expenses > 0 &&
              profit > 0
            ) {
              performance =
                "The company is currently operating at a profit based on the recorded paid transactions.";
            }

            if (
              income > 0 &&
              expenses > 0 &&
              profit < 0
            ) {
              performance =
                "The company is currently operating at a loss based on the recorded paid transactions.";
            }

            if (
              income > 0 &&
              expenses === 0
            ) {
              performance =
                "Income has been recorded, but no paid expenses are currently included in the transaction summary.";
            }

            if (
              income === 0 &&
              expenses > 0
            ) {
              performance =
                "Expenses have been recorded, but no paid income is currently included in the transaction summary.";
            }

            const currency =
              summary.transactions
                ?.find(
                  transaction =>
                    transaction.currency
                )
                ?.currency ||
              summary.invoices
                ?.find(
                  invoice =>
                    invoice.currency
                )
                ?.currency ||
              "LKR";

            const recommendation =
              profit < 0
                ? "Review recurring infrastructure costs and identify services that are not generating enough revenue."
                : profit > 0
                  ? "Continue monitoring expenses and focus on services producing sustainable recurring revenue."
                  : "Continue recording all income and expenses so the company's financial performance can be tracked accurately.";

            return message.reply(
              `# 📊 Aura Cloud Company Analysis

**Overall Performance:** ${performance}

## 💰 Financial Summary

**Recorded Income:** ${income.toLocaleString()} ${currency}

**Recorded Expenses:** ${expenses.toLocaleString()} ${currency}

**Recorded Profit:** ${profit.toLocaleString()} ${currency}

**Paid Invoice Revenue:** ${paidInvoiceRevenue.toLocaleString()} ${currency}

## 📁 Company Records

**Total Invoices:** ${summary.totalInvoices}

**Total Transactions:** ${summary.totalTransactions}

## 💡 Recommendation

${recommendation}

⚠️ AI analysis is temporarily unavailable. The figures above are calculated directly from the verified accounting records.`
            );
          }
        } catch (
          error
        ) {
          console.error(
            "Company analysis error:",
            error
          );

          return message.reply(
            "❌ Unable to retrieve the requested accounting data. Please check Firebase configuration."
          );
        }
      }
    } catch (
      error
    ) {
      console.error(
        "Message command error:",
        error
      );
    }
  }
);

/* ============================================================
   BUTTONS AND MODALS
============================================================ */

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      /* ======================================================
         DISCOUNT ADD SLASH COMMAND
      ====================================================== */
      if (await handleDiscountAddCommand(interaction)) {
        return;
      }

      /* ======================================================
         RENEW SLASH COMMAND
      ====================================================== */

      if (
        await handleRenewSlashCommand(
          interaction
        )
      ) {
        return;
      }

      /* ======================================================
         BUY SLASH COMMAND
      ====================================================== */

      if (
        await handleBuySlashCommand(
          interaction
        )
      ) {
        return;
      }

      /* ======================================================
         BUY INTERACTIONS
      ====================================================== */

      if (
        await handleBuyInteraction(
          interaction
        )
      ) {
        return;
      }

      /* ========================================================
         INVOICE DRAFT SETTINGS
      ======================================================== */

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("invoice_setting:")) {
        const [, pendingId, field] = interaction.customId.split(":");
        const draft = pendingInvoices.get(pendingId);
        if (!draft) {
          return interaction.reply({ content: "❌ This invoice draft expired. Please create a new invoice with `!inv`.", ephemeral: true });
        }
        if (interaction.user.id !== draft.requestedBy) {
          return interaction.reply({ content: "❌ Only the user who created this invoice can change its settings.", ephemeral: true });
        }
        const selected = interaction.values[0];
        if (field === "currency" && ["LKR", "USD"].includes(selected)) draft.currency = selected;
        if (field === "billingCycle" && ["Monthly", "Yearly", "One-time"].includes(selected)) draft.billingCycle = selected;
        if (field === "status" && ["Paid", "Not Paid"].includes(selected)) draft.status = selected;
        pendingInvoices.set(pendingId, draft);
        return interaction.update({
          content: invoiceDraftContent(draft),
          components: invoiceDraftComponents(pendingId, draft)
        });
      }

      /* ========================================================
         INVOICE BUTTON
      ======================================================== */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "create_invoice:"
        )
      ) {
        const pendingId =
          interaction.customId
            .split(":")[1];

        const draft =
          pendingInvoices.get(
            pendingId
          );

        if (!draft) {
          return interaction.reply({
            content:
              "❌ This invoice draft expired. Please create a new invoice with `!inv`.",

            ephemeral:
              true
          });
        }

        if (
          interaction.user.id !==
          draft.requestedBy
        ) {
          return interaction.reply({
            content:
              "❌ Only the user who created this invoice can complete it.",

            ephemeral:
              true
          });
        }

        const modal =
          new ModalBuilder()
            .setCustomId(
              `invoice_modal:${pendingId}`
            )
            .setTitle(
              "Aura Cloud Client Details"
            );

        const nameInput =
          new TextInputBuilder()
            .setCustomId(
              "name"
            )
            .setLabel(
              "Client Name"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              true
            );

        const emailInput =
          new TextInputBuilder()
            .setCustomId(
              "email"
            )
            .setLabel(
              "Client Email (Optional)"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              false
            );

        const phoneInput =
          new TextInputBuilder()
            .setCustomId(
              "phone"
            )
            .setLabel(
              "Client Phone (Optional)"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              false
            );

        const companyInput =
          new TextInputBuilder()
            .setCustomId(
              "company"
            )
            .setLabel(
              "Company (Optional)"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              false
            );

        const addressInput =
          new TextInputBuilder()
            .setCustomId(
              "address"
            )
            .setLabel(
              "Address (Optional)"
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setRequired(
              false
            );

        modal.addComponents(
          new ActionRowBuilder()
            .addComponents(
              nameInput
            ),

          new ActionRowBuilder()
            .addComponents(
              emailInput
            ),

          new ActionRowBuilder()
            .addComponents(
              phoneInput
            ),

          new ActionRowBuilder()
            .addComponents(
              companyInput
            ),

          new ActionRowBuilder()
            .addComponents(
              addressInput
            )
        );

        return interaction.showModal(
          modal
        );
      }

      /* ========================================================
         INVOICE MODAL SUBMIT
      ======================================================== */

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          "invoice_modal:"
        )
      ) {
        await interaction.deferReply();

        const pendingId =
          interaction.customId
            .split(":")[1];

        const draft =
          pendingInvoices.get(
            pendingId
          );

        if (!draft) {
          return interaction.editReply(
            "❌ This invoice draft expired."
          );
        }

        if (
          interaction.user.id !==
          draft.requestedBy
        ) {
          return interaction.editReply(
            "❌ You are not authorized to complete this invoice."
          );
        }

        try {
          const customer = {
            name:
              interaction.fields
                .getTextInputValue(
                  "name"
                )
                .trim(),

            email:
              interaction.fields
                .getTextInputValue(
                  "email"
                )
                .trim(),

            phone:
              interaction.fields
                .getTextInputValue(
                  "phone"
                )
                .trim(),

            company:
              interaction.fields
                .getTextInputValue(
                  "company"
                )
                .trim(),

            address:
              interaction.fields
                .getTextInputValue(
                  "address"
                )
                .trim()
          };

          const invoiceNumber =
            await getNextInvoiceNumber();

          const totals =
            calculateInvoice(
              draft
            );

          const purchaseDate =
            safeDate(
              draft.purchaseDate,
              draft.originalExplanation
            );

          const invoice = {
            ...draft,
            invoiceNumber,
            customer,
            ...totals,
            purchaseDate,
            expiryDate: draft.expiryDate || "",
            status: "Awaiting Approval",
            paymentStatus: draft.status === "Paid" ? "Paid" : "Not Paid",
            createdAt: new Date().toISOString(),
            createdBy: { userId: interaction.user.id, username: interaction.user.tag || interaction.user.username }
          };

          const { xlsxPath, pdfPath } = await createInvoiceFiles(invoice);
          invoice.xlsxPath = xlsxPath;
          invoice.pdfPath = pdfPath;

          // Store only as a pending draft. The official Invoices database/Sheet is
          // written after an authorized admin approves it with !ap.
          await initFirebase().ref(`pendingInvoiceApprovals/${invoiceNumber}`).set(invoice);
          pendingInvoices.delete(pendingId);

          return interaction.editReply({
            content: `# 📄 Invoice Preview — Awaiting Approval\n\n**Invoice Number:** \`${invoiceNumber}\`\n**Client:** ${customer.name}\n**Email:** ${customer.email || "Not provided"}\n**Description:** ${invoice.description || "Not specified"}\n**Total:** ${invoice.currency || "LKR"} ${Number(invoice.total || 0).toLocaleString()}\n**Payment Status:** ${invoice.paymentStatus}\n**Approval Status:** Awaiting Approval\n\nThe PDF below is a preview. An authorized admin must approve it with \`!ap @user ${invoiceNumber}\`. It has not yet been added to the official Invoices sheet/database.`,
            files: [new AttachmentBuilder(pdfPath, { name: `${invoiceNumber}-PREVIEW.pdf` })]
          });
        } catch (
          error
        ) {
          console.error(
            "Invoice creation error:",
            error
          );

          return interaction.editReply(
            `❌ Failed to create invoice: ${error.message}`
          );
        }
      }
    } catch (
      error
    ) {
      console.error(
        "Interaction error:",
        error
      );

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        try {
          await interaction.editReply(
            "❌ An unexpected error occurred."
          );
        } catch {}
      } else {
        try {
          await interaction.reply({
            content:
              "❌ An unexpected error occurred.",

            ephemeral:
              true
          });
        } catch {}
      }
    }
  }
);

/* ============================================================
   START BOT
============================================================ */

if (
  !process.env.DISCORD_TOKEN
) {
  console.error(
    "❌ DISCORD_TOKEN is missing from .env"
  );

  process.exit(1);
}

startPayPalCallbackServer(client);

client.login(
  process.env.DISCORD_TOKEN
);