import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

const outputDir = path.resolve(
  process.env.PDF_OUTPUT_DIR || "./output"
);

function money(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function cleanDescription(value) {
  return String(value || "Hosting service")
    .replace(/\\b(?:for|at|price(?:d)?(?:\\s+at)?|cost(?:s)?(?:\\s+of)?)\\s*(?:USD\\s*|LKR\\s*|Rs\\.?\\s*|\\$\\s*)[\\d,]+(?:\\.\\d{1,2})?\\b/gi, " ")
    .replace(/\\b(?:for|at|price(?:d)?(?:\\s+at)?|cost(?:s)?(?:\\s+of)?)\\s*[\\d,]+(?:\\.\\d{1,2})?\\s*\\$/gi, " ")
    .replace(/\\b(?:USD|LKR|Rs\\.?)\\s*[\\d,]+(?:\\.\\d{1,2})?\\b/gi, " ")
    .replace(/\\$\\s*[\\d,]+(?:\\.\\d{1,2})?\\b/g, " ")
    .replace(/\\b[\\d,]+(?:\\.\\d{1,2})?\\s*(?:USD|LKR|Rs\\.?)/gi, " ")
    .replace(/\\b[\\d,]+(?:\\.\\d{1,2})?\\s*\\$/g, " ")
    .replace(/\\s+([,.])/g, "$1")
    .replace(/\\s{2,}/g, " ")
    .replace(/^[\\s,;:.\\-]+|[\\s,;:.\\-]+$/g, "")
    .trim() || "Hosting service";
}

function currencyCode(value) {
  return String(value || "LKR").trim().toUpperCase() === "USD"
    ? "USD"
    : "LKR";
}

function formatMoney(value, currency) {
  const amount = money(value);
  return currency === "USD"
    ? "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "LKR " + amount.toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function billingCycleLabel(value) {
  const cycle = String(value || "Monthly").trim().toLowerCase();
  if (/year|annual/.test(cycle)) return "Yearly";
  if (/one[- ]?time/.test(cycle)) return "One-time";
  return "Monthly";
}

function safeText(value, fallback = "—") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function drawLabelValue(doc, label, value, x, y, width = 235) {
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#73738a")
    .text(label.toUpperCase(), x, y, { width });
  doc.font("Helvetica").fontSize(10).fillColor("#171725")
    .text(safeText(value), x, y + 13, { width, lineGap: 2 });
}

function drawRule(doc, y, left = 48, right = 547, color = "#e5e5ef") {
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.7).strokeColor(color).stroke();
}

/*
 * PDFKit-only invoice generation.
 * Kept compatible with payments.js: createInvoiceFiles() returns
 * { xlsxPath, pdfPath }, with xlsxPath set to null because no spreadsheet
 * or LibreOffice conversion is required.
 */
export async function createInvoiceFiles(data = {}) {
  const invoiceNumber = String(data.invoiceNumber || "").replace(/\\D/g, "");
  if (!invoiceNumber) {
    throw new Error("A numeric invoice number is required to generate an invoice.");
  }

  await fs.promises.mkdir(outputDir, { recursive: true });

  const pdfPath = path.join(outputDir, invoiceNumber + ".pdf");
  const currency = currencyCode(data.currency);
  const description = cleanDescription(data.description);
  const quantity = Math.max(1, money(data.quantity || 1));
  const unitPrice = money(data.unitPrice);
  const discount = Math.max(0, money(data.discount));
  const tax = Math.max(0, money(data.tax));
  const calculated = calculateInvoice({
    quantity,
    unitPrice,
    discount,
    tax
  });
  const subtotal = money(data.subtotal ?? calculated.subtotal);
  const lineTotal = money(data.lineTotal ?? calculated.lineTotal);
  const total = money(data.total ?? calculated.total);
  const status = String(
    data.paymentStatus || (String(data.status || "").toLowerCase() === "paid" ? "Paid" : "Not Paid")
  ).toLowerCase() === "paid" ? "Paid" : "Not Paid";

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 46, bottom: 46, left: 48, right: 48 },
    info: {
      Title: "Aura Cloud Hosting Invoice " + invoiceNumber,
      Author: "Aura Cloud Hosting",
      Subject: "Hosting service invoice"
    },
    bufferPages: true
  });

  const stream = fs.createWriteStream(pdfPath);
  const finished = new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
  });
  doc.pipe(stream);

  // Brand header
  doc.rect(0, 0, doc.page.width, 145).fill("#090816");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(23)
    .text("AURA CLOUD", 48, 43, { characterSpacing: 1.2 });
  doc.fillColor("#b9b5ff").font("Helvetica").fontSize(9)
    .text("HOSTING  •  NEXT-GEN CLOUD HOSTING", 49, 73);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26)
    .text("INVOICE", 365, 43, { width: 180, align: "right" });
  doc.fillColor("#d8d6f4").font("Helvetica").fontSize(9)
    .text("#" + invoiceNumber, 365, 78, { width: 180, align: "right" });
  doc.fillColor(status === "Paid" ? "#8ff0c5" : "#ffd28b").font("Helvetica-Bold").fontSize(9)
    .text(status.toUpperCase(), 365, 96, { width: 180, align: "right" });

  let y = 171;
  drawLabelValue(doc, "Bill to", data.customer?.name, 48, y, 235);
  drawLabelValue(doc, "Invoice date", data.purchaseDate, 330, y, 215);
  y += 47;
  drawLabelValue(doc, "Email", data.customer?.email, 48, y, 235);
  drawLabelValue(doc, "Service expiry", data.expiryDate, 330, y, 215);
  y += 47;
  drawLabelValue(doc, "Company", data.customer?.company, 48, y, 235);
  drawLabelValue(doc, "Payment status", status, 330, y, 215);
  y += 47;
  drawLabelValue(doc, "Address / contact", data.customer?.address || data.customer?.phone, 48, y, 235);
  drawLabelValue(doc, "Billing cycle", billingCycleLabel(data.billingCycle), 330, y, 215);

  y += 54;
  drawRule(doc, y, 48, 547, "#c9c7e8");

  // Table header
  const tableTop = y + 13;
  doc.roundedRect(48, tableTop, 499, 30, 5).fill("#f0effb");
  doc.fillColor("#4a4770").font("Helvetica-Bold").fontSize(8);
  doc.text("DESCRIPTION", 60, tableTop + 10, { width: 190 });
  doc.text("QTY", 255, tableTop + 10, { width: 35, align: "right" });
  doc.text("UNIT PRICE", 300, tableTop + 10, { width: 80, align: "right" });
  doc.text("DISCOUNT", 385, tableTop + 10, { width: 70, align: "right" });
  doc.text("TOTAL", 460, tableTop + 10, { width: 75, align: "right" });

  const rowY = tableTop + 43;
  doc.fillColor("#1b1a2b").font("Helvetica-Bold").fontSize(9)
    .text(description, 60, rowY, { width: 184, lineGap: 3 });
  doc.font("Helvetica").fontSize(9).fillColor("#3c3a50")
    .text(String(quantity), 255, rowY, { width: 35, align: "right" })
    .text(formatMoney(unitPrice, currency), 300, rowY, { width: 80, align: "right" })
    .text(formatMoney(discount, currency), 385, rowY, { width: 70, align: "right" })
    .text(formatMoney(lineTotal, currency), 460, rowY, { width: 75, align: "right" });

  const descriptionHeight = doc.heightOfString(description, { width: 184, font: "Helvetica-Bold", fontSize: 9, lineGap: 3 });
  y = rowY + Math.max(36, descriptionHeight + 20);
  drawRule(doc, y, 48, 547);

  // Totals
  const totalsX = 335;
  const totalsValueX = 435;
  y += 18;
  const totalRow = (label, value, bold = false, color = "#242238") => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(color)
      .text(label, totalsX, y, { width: 95 });
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(color)
      .text(value, totalsValueX, y, { width: 110, align: "right" });
    y += bold ? 27 : 21;
  };
  totalRow("Subtotal", formatMoney(subtotal, currency));
  totalRow("Tax", formatMoney(tax, currency));
  doc.roundedRect(325, y - 2, 222, 34, 5).fill("#090816");
  totalRow("TOTAL DUE", formatMoney(total, currency), true, "#ffffff");

  y += 24;
  if (y > 690) {
    doc.addPage();
    y = 60;
  }
  doc.fillColor("#6f6d83").font("Helvetica-Bold").fontSize(8)
    .text("NOTES", 48, y);
  doc.fillColor("#55536a").font("Helvetica").fontSize(9)
    .text("Thank you for choosing Aura Cloud Hosting. Please keep this invoice for your records.", 48, y + 14, {
      width: 499,
      lineGap: 3
    });

  // Footer on every page (currently one page for typical invoices).
  const pages = doc.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    doc.moveTo(48, 790).lineTo(547, 790).lineWidth(0.6).strokeColor("#e5e5ef").stroke();
    doc.fillColor("#77758a").font("Helvetica").fontSize(8)
      .text("Aura Cloud Hosting  •  auracloud.cloud", 48, 802, { width: 300 });
    doc.text("Invoice " + invoiceNumber, 390, 802, { width: 157, align: "right" });
  }

  doc.end();
  await finished;

  const stat = await fs.promises.stat(pdfPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error("PDF invoice generation finished, but the PDF file is empty.");
  }

  return {
    xlsxPath: null,
    pdfPath
  };
}

/*
 * Calculate invoice totals while preserving the original module API.
 */
export function calculateInvoice(invoiceData = {}) {
  const quantity = Math.max(1, money(invoiceData.quantity));
  const unitPrice = money(invoiceData.unitPrice);
  const discount = Math.max(0, money(invoiceData.discount));
  const tax = Math.max(0, money(invoiceData.tax));
  const subtotal = quantity * unitPrice;
  const lineTotal = Math.max(0, subtotal - discount);
  const total = lineTotal + tax;

  return {
    quantity,
    unitPrice,
    discount,
    tax,
    subtotal,
    lineTotal,
    total
  };
}
