import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const templatePath = path.resolve(
  "./templates/aura-cloud-invoice.xlsx"
);

const outputDir = path.resolve("./output");

/*
============================================================
LIBREOFFICE PATH
============================================================
*/

const libreOfficePath =
  process.platform === "win32"
    ? "C:\\Program Files\\LibreOffice\\program\\soffice.exe"
    : "libreoffice";

/*
============================================================
MONEY HELPER
============================================================
*/

function money(value) {
  const number = Number(value || 0);

  return Number.isFinite(number)
    ? number
    : 0;
}

function cleanDescription(value) {
  return String(value || "Hosting service")
    .replace(/\b(?:for|at|price(?:d)?(?:\s+at)?|cost(?:s)?(?:\s+of)?)\s*(?:USD\s*|LKR\s*|Rs\.?\s*|\$\s*)[\d,]+(?:\.\d{1,2})?\b/gi, " ")
    .replace(/\b(?:for|at|price(?:d)?(?:\s+at)?|cost(?:s)?(?:\s+of)?)\s*[\d,]+(?:\.\d{1,2})?\s*\$/gi, " ")
    .replace(/\b(?:USD|LKR|Rs\.?)\s*[\d,]+(?:\.\d{1,2})?\b/gi, " ")
    .replace(/\$\s*[\d,]+(?:\.\d{1,2})?\b/g, " ")
    .replace(/\b[\d,]+(?:\.\d{1,2})?\s*(?:USD|LKR|Rs\.?)/gi, " ")
    .replace(/\b[\d,]+(?:\.\d{1,2})?\s*\$/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, "")
    .trim() || "Hosting service";
}

const LKR_FORMAT = '_-[$Rs.-849]* #,##0.00_-;\\-[$Rs.-849]* #,##0.00_-;_-[$Rs.-849]* "-"??_-;_-@_-';
const USD_FORMAT = '"$"#,##0.00;[Red]-"$"#,##0.00;"$"0.00';

/*
============================================================
CREATE INVOICE FILES
============================================================
*/

export async function createInvoiceFiles(data) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(
      "Invoice template not found: templates/aura-cloud-invoice.xlsx"
    );
  }

  fs.mkdirSync(outputDir, {
    recursive: true
  });

  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.readFile(
    templatePath
  );

  const sheet =
    workbook.getWorksheet(
      "Aura Cloud Invoice"
    ) || workbook.worksheets[0];

  if (!sheet) {
    throw new Error(
      "No worksheet found in invoice template."
    );
  }

  /*
  ============================================================
  SAFE CELL SETTER
  ============================================================
  */

  const set = (cell, value) => {
    sheet.getCell(cell).value =
      value ?? "";
  };

  /*
  ============================================================
  CUSTOMER INFORMATION
  ============================================================
  */

  set(
    "B5",
    data.customer?.name
  );

  set(
    "B6",
    data.customer?.email
  );

  set(
    "B7",
    data.customer?.company
  );

  set(
    "B8",
    data.customer?.address ||
      data.customer?.phone
  );

  /*
  ============================================================
  INVOICE INFORMATION
  ============================================================
  */

  // Invoice number is numeric only.
  const invoiceNumber = String(
    data.invoiceNumber || ""
  ).replace(/\D/g, "");

  set(
    "G4",
    invoiceNumber
  );

  set(
    "G5",
    data.purchaseDate
  );

  set(
    "G6",
    data.expiryDate
  );

  const paymentStatus = String(
    data.paymentStatus || (String(data.status || "").toLowerCase() === "paid" ? "Paid" : "Not Paid")
  ).toLowerCase() === "paid" ? "Paid" : "Not Paid";

  set(
    "G7",
    paymentStatus
  );

  /*
  ============================================================
  PRODUCT / SERVICE
  ============================================================
  */

  const description = cleanDescription(data.description);
  set("A12", description);
  set("B12", data.quantity);

  const cycleText = String(data.billingCycle || "Monthly").trim().toLowerCase();
  const billingCycle = /year|annual/.test(cycleText)
    ? "Yearly"
    : /one[- ]?time/.test(cycleText)
      ? "One-time"
      : "Monthly";
  set("C12", billingCycle);

  // Keep the full description readable in both Excel and the PDF export.
  const descriptionCell = sheet.getCell("A12");
  descriptionCell.alignment = { ...descriptionCell.alignment, wrapText: true, vertical: "top" };
  descriptionCell.font = { ...descriptionCell.font, size: 10 };
  sheet.getColumn("A").width = Math.max(sheet.getColumn("A").width || 28, 32);
  const estimatedLines = Math.max(1, Math.ceil(description.length / 38));
  sheet.getRow(12).height = Math.min(120, Math.max(30, estimatedLines * 15));
  for (const cellAddress of ["B12", "C12", "D12", "E12", "F12", "G12"]) {
    const cell = sheet.getCell(cellAddress);
    cell.alignment = { ...cell.alignment, vertical: "top", wrapText: true };
  }

  set(
    "D12",
    data.unitPrice
  );

  set(
    "E12",
    data.discount
  );

  set(
    "F12",
    data.tax
  );

  set(
    "G12",
    data.lineTotal
  );

  // Apply currency only to this generated invoice workbook. The original template stays unchanged.
  const currency = String(data.currency || "LKR").trim().toUpperCase() === "USD" ? "USD" : "LKR";
  const amountFormat = currency === "USD" ? USD_FORMAT : LKR_FORMAT;
  for (const col of ["D", "E", "F", "G"]) {
    sheet.getCell(`${col}11`).value = String(sheet.getCell(`${col}11`).value || "").replace(/\((?:LKR|USD|RS\.?)\)/ig, `(${currency})`);
  }
  for (let row = 12; row <= 21; row++) {
    for (const col of ["D", "E", "F", "G"]) {
      sheet.getCell(`${col}${row}`).numFmt = amountFormat;
    }
  }
  for (const cell of ["G23", "G24", "G25"]) {
    sheet.getCell(cell).numFmt = amountFormat;
  }

  /*
  ============================================================
  SUMMARY
  ============================================================
  */

  set(
    "G23",
    data.subtotal
  );

  set(
    "G24",
    data.tax
  );

  set(
    "G25",
    data.total
  );

  /*
  ============================================================
  FILE PATHS
  ============================================================
  */

  const xlsxPath = path.join(
    outputDir,
    `${invoiceNumber}.xlsx`
  );

  const pdfPath = path.join(
    outputDir,
    `${invoiceNumber}.pdf`
  );

  /*
  ============================================================
  WRITE EXCEL FILE
  ============================================================
  */

  await workbook.xlsx.writeFile(
    xlsxPath
  );

  /*
  ============================================================
  CONVERT EXCEL -> PDF
  ============================================================
  */

  try {
    await execFileAsync(
      libreOfficePath,
      [
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        xlsxPath
      ]
    );
  } catch (error) {
    console.error(
      "LibreOffice error:",
      error
    );

    throw new Error(
      `PDF conversion failed. LibreOffice executable was not found or conversion failed.\nPath: ${libreOfficePath}`
    );
  }

  /*
  ============================================================
  VERIFY PDF
  ============================================================
  */

  if (!fs.existsSync(pdfPath)) {
    throw new Error(
      "PDF conversion completed but no PDF file was created."
    );
  }

  return {
    xlsxPath,
    pdfPath
  };
}

/*
============================================================
CALCULATE INVOICE
============================================================
*/

export function calculateInvoice(invoiceData) {
  const quantity = Math.max(
    1,
    money(invoiceData.quantity)
  );

  const unitPrice = money(
    invoiceData.unitPrice
  );

  const discount = Math.max(
    0,
    money(invoiceData.discount)
  );

  const tax = Math.max(
    0,
    money(invoiceData.tax)
  );

  // Price before discount/tax
  const subtotal =
    quantity * unitPrice;

  // Discount applies to the whole line
  const lineTotal = Math.max(
    0,
    subtotal - discount
  );

  // Final invoice total
  const total =
    lineTotal + tax;

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
