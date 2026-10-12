import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

const OUTPUT_DIR = path.resolve(process.env.PDF_OUTPUT_DIR || "./generated_invoices");

const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const text = (value, fallback = "—") => {
  if (value === null || value === undefined) return fallback;
  const result = String(value).trim();
  return result || fallback;
};

const money = (value, currency = "LKR") =>
  `${currency} ${number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

function field(doc, label, value, x, y, valueWidth = 190) {
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#6B7280")
    .text(label, x, y, { width: 94 });
  doc.font("Helvetica").fontSize(8.5).fillColor("#111827")
    .text(text(value), x + 96, y, { width: valueWidth });
}

function ensureRoom(doc, height = 70) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

export function calculateInvoice(data = {}) {
  const quantity = Math.max(1, number(data.quantity, 1));
  const unitPrice = Math.max(0, number(data.unitPrice));
  const discount = Math.max(0, number(data.discount));
  const tax = Math.max(0, number(data.tax));
  const subtotal = quantity * unitPrice;
  const lineTotal = Math.max(0, subtotal - discount);
  const total = lineTotal + tax;

  return { quantity, unitPrice, discount, tax, subtotal, lineTotal, total };
}

/**
 * PDFKit invoice renderer. Does not require LibreOffice, Excel, or a system
 * office suite. Keeps the { xlsxPath, pdfPath } return shape expected by
 * payments.js; xlsxPath is null because this generator intentionally creates
 * a PDF only.
 */
export async function createInvoiceFiles(data = {}) {
  const invoiceNumber = text(data.invoiceNumber, "").replace(/[^0-9]/g, "");
  if (!invoiceNumber) {
    throw new Error("Cannot create invoice: invoiceNumber must contain digits.");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const pdfPath = path.join(OUTPUT_DIR, `${invoiceNumber}.pdf`);
  const currency = text(data.currency, "LKR");
  const customer = data.customer && typeof data.customer === "object" ? data.customer : {};
  const totals = calculateInvoice({
    quantity: data.quantity,
    unitPrice: data.unitPrice,
    discount: data.discount,
    tax: data.tax
  });

  const subtotal = number(data.subtotal, totals.subtotal);
  const discount = number(data.discount, totals.discount);
  const tax = number(data.tax, totals.tax);
  const lineTotal = number(data.lineTotal, totals.lineTotal);
  const total = number(data.total, totals.total);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 42, right: 46, bottom: 48, left: 46 },
      info: {
        Title: `Aura Cloud Invoice ${invoiceNumber}`,
        Author: "Aura Cloud Hosting",
        Subject: "Hosting service invoice"
      }
    });

    const output = fs.createWriteStream(pdfPath);
    let settled = false;
    const fail = error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    output.once("error", fail);
    doc.once("error", fail);
    output.once("finish", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    doc.pipe(output);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Branded Aura Cloud header.
    doc.rect(0, 0, doc.page.width, 112).fill("#080711");
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(21)
      .text("AURA CLOUD", left, 34);
    doc.fillColor("#A78BFA").font("Helvetica").fontSize(8.5)
      .text("NEXT-GEN CLOUD HOSTING", left, 62);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(22)
      .text("INVOICE", 340, 35, { width: right - 340, align: "right" });
    doc.fillColor("#D1D5DB").font("Helvetica").fontSize(9)
      .text(`# ${invoiceNumber}`, 340, 66, { width: right - 340, align: "right" });

    let y = 136;
    doc.fillColor("#4C1D95").font("Helvetica-Bold").fontSize(9)
      .text("BILL TO", left, y);
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(12)
      .text(text(customer.name, text(data.customerName, "Customer")), left, y + 17, { width: 235 });

    let customerY = y + 37;
    for (const value of [
      customer.email || data.customerEmail,
      customer.company,
      customer.address,
      customer.phone
    ]) {
      if (value && String(value).trim()) {
        doc.font("Helvetica").fontSize(8.5).fillColor("#4B5563")
          .text(String(value), left, customerY, { width: 238 });
        customerY += 13;
      }
    }

    const metaX = 333;
    field(doc, "Invoice number", invoiceNumber, metaX, y, 170);
    field(doc, "Issue date", data.purchaseDate || data.createdAt, metaX, y + 19, 170);
    field(doc, "Service expiry", data.expiryDate, metaX, y + 38, 170);
    field(doc, "Payment status", data.paymentStatus || data.status || "Paid", metaX, y + 57, 170);

    y = Math.max(customerY + 19, y + 88);
    ensureRoom(doc, 120);

    // Invoice item table.
    doc.roundedRect(left, y, width, 27, 4).fill("#F3F0FF");
    doc.fillColor("#4C1D95").font("Helvetica-Bold").fontSize(8);
    doc.text("DESCRIPTION", left + 8, y + 9, { width: 210 });
    doc.text("QTY", left + 224, y + 9, { width: 28, align: "right" });
    doc.text("BILLING", left + 262, y + 9, { width: 63 });
    doc.text("UNIT PRICE", left + 329, y + 9, { width: 72, align: "right" });
    doc.text("TOTAL", right - 62, y + 9, { width: 54, align: "right" });

    y += 27;
    const description = text(data.description, text(data.service || data.serverName, "Hosting service"));
    doc.font("Helvetica").fontSize(8.5);
    const descriptionHeight = doc.heightOfString(description, { width: 200 });
    const rowHeight = Math.max(38, descriptionHeight + 18);
    ensureRoom(doc, rowHeight + 130);

    doc.fillColor("#111827").font("Helvetica").fontSize(8.5)
      .text(description, left + 8, y + 10, { width: 200 });
    doc.text(String(totals.quantity), left + 224, y + 10, { width: 28, align: "right" });
    doc.text(text(data.billingCycle || data.duration), left + 262, y + 10, { width: 63 });
    doc.text(money(totals.unitPrice, currency), left + 329, y + 10, { width: 72, align: "right" });
    doc.text(money(lineTotal, currency), right - 70, y + 10, { width: 62, align: "right" });
    doc.strokeColor("#E5E7EB").lineWidth(0.7)
      .moveTo(left, y + rowHeight).lineTo(right, y + rowHeight).stroke();

    y += rowHeight + 24;
    ensureRoom(doc, 140);

    const summaryX = right - 224;
    const valueX = right - 106;
    const summaryLine = (label, amount, strong = false) => {
      doc.font(strong ? "Helvetica-Bold" : "Helvetica")
        .fontSize(strong ? 11 : 9)
        .fillColor(strong ? "#4C1D95" : "#374151")
        .text(label, summaryX, y, { width: 112 });
      doc.text(money(amount, currency), valueX, y, { width: 100, align: "right" });
      y += strong ? 25 : 19;
    };

    summaryLine("Subtotal", subtotal);
    if (discount > 0) summaryLine("Discount", -discount);
    if (tax > 0) summaryLine("Tax", tax);
    doc.strokeColor("#C4B5FD").lineWidth(1)
      .moveTo(summaryX, y - 4).lineTo(right, y - 4).stroke();
    summaryLine("TOTAL PAID", total, true);

    y += 22;
    ensureRoom(doc, 65);
    doc.fillColor("#6B7280").font("Helvetica").fontSize(8)
      .text("Thank you for choosing Aura Cloud Hosting.", left, y, { width, align: "center" });
    doc.text("This invoice was generated electronically.", left, y + 14, { width, align: "center" });
    doc.end();
  });

  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
    throw new Error("PDF invoice generation failed: output file is missing or empty.");
  }

  return {
    invoiceNumber,
    xlsxPath: null,
    pdfPath,
    totals: { ...totals, subtotal, discount, tax, lineTotal, total }
  };
}
