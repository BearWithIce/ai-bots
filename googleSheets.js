import { google } from "googleapis";
import fs from "fs";
import path from "path";

let sheets;

/* =====================================================
   GET GOOGLE SHEETS API
===================================================== */

async function getSheets() {
  if (sheets) return sheets;

  const file =
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||
    "./google-service-account.json";

  const credentials = JSON.parse(
    fs.readFileSync(
      path.resolve(file),
      "utf8"
    )
  );

  const auth =
    new google.auth.GoogleAuth({
      credentials,

      scopes: [
        "https://www.googleapis.com/auth/spreadsheets"
      ]
    });

  sheets = google.sheets({
    version: "v4",
    auth
  });

  return sheets;
}

/* =====================================================
   ENSURE SHEETS + HEADERS
===================================================== */

async function ensureSheets() {
  const api = await getSheets();

  let spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const requiredSheetNames = ["Transactions", "Invoices", "Orders", "Accounts"];
  if (!spreadsheetId) {
    const created = await api.spreadsheets.create({
      requestBody: {
        properties: { title: "Aura Cloud Manager — Accounting" },
        sheets: requiredSheetNames.map(title => ({ properties: { title } }))
      },
      fields: "spreadsheetId,spreadsheetUrl,properties.title"
    });
    spreadsheetId = created.data.spreadsheetId;
    process.env.GOOGLE_SHEET_ID = spreadsheetId;
    const envPath = path.resolve(".env");
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    if (/^GOOGLE_SHEET_ID=/m.test(envText)) {
      fs.writeFileSync(envPath, envText.replace(/^GOOGLE_SHEET_ID=.*$/m, `GOOGLE_SHEET_ID=${spreadsheetId}`));
    } else {
      fs.appendFileSync(envPath, `${envText.endsWith("\n") || !envText ? "" : "\n"}GOOGLE_SHEET_ID=${spreadsheetId}\n`);
    }
    console.log(`Created Google spreadsheet: ${created.data.spreadsheetUrl}`);
    console.log("If needed, share this spreadsheet with your own Google account. Service account email is in google-service-account.json.");
  }

  let spreadsheet = await api.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties"
  });

  let existingSheets = spreadsheet.data.sheets || [];

  const existingNames = existingSheets.map(sheet => sheet.properties.title);

  const requiredSheets = [

    /* =====================================================
       TRANSACTIONS
    ===================================================== */

    {
      name: "Transactions",

      headers: [
        "Created At",
        "Transaction ID",
        "Type",
        "Amount",
        "Currency",
        "Description",
        "Service",
        "Payment Method",
        "Status",
        "Transaction Date"
      ]
    },

    /* =====================================================
       INVOICES
    ===================================================== */

    {
      name: "Invoices",

      headers: [
        "Invoice Number",
        "Client Name",
        "Email",
        "Phone",
        "Company",
        "Address",
        "Description",
        "Quantity",
        "Billing Cycle",
        "Unit Price",
        "Discount",
        "Tax",
        "Total",
        "Currency",
        "Status",
        "Purchase Date",
        "Expiry Date",
        "Created At"
      ]
    },

    /* =====================================================
       ORDERS
    ===================================================== */

    {
      name: "Orders",

      headers: [
        "Order Number",
        "Discord User ID",
        "Discord Username",
        "Client Name",
        "Email",
        "Address",
        "RAM",
        "Disk",
        "CPU",
        "Location",
        "Price",
        "Discount Code",
        "Discount",
        "Total",
        "Payment Method",
        "Status",
        "Invoice Number",
        "Created At",
        "Confirmed At"
      ]
    },

    /* =====================================================
       ACCOUNTS
    ===================================================== */

    {
      name: "Accounts",

      headers: [
        "Discord User ID",
        "Discord Username",
        "Client Name",
        "Email",
        "Phone",
        "Address",
        "Order Number",
        "Server Name",
        "RAM",
        "Disk",
        "CPU",
        "Location",
        "Amount",
        "Currency",
        "Account Status",
        "Payment Status",
        "Last Payment Date",
        "Last Invoice Number",
        "Expiry Date",
        "Updated At"
      ]
    },

    /* =====================================================
       RENEWALS
    ===================================================== */

    {
      name: "Renewals",

      headers: [
        "Renewal ID",
        "Previous Order Number",
        "Discord User ID",
        "Discord Username",
        "Client Name",
        "Email",
        "Server Name",
        "RAM",
        "Disk",
        "CPU",
        "Location",
        "Amount",
        "Currency",
        "Payment Method",
        "Status",
        "Invoice Number",
        "Previous Expiry Date",
        "New Expiry Date",
        "Created At",
        "Confirmed At",
        "Confirmed By"
      ]
    }

  ];

  const requests = [];

  /* =====================================================
     CREATE MISSING TABS
  ===================================================== */

  for (
    const sheet of requiredSheets
  ) {

    if (
      !existingNames.includes(
        sheet.name
      )
    ) {

      console.log(
        `📊 Creating Google Sheet tab: ${sheet.name}`
      );

      requests.push({

        addSheet: {

          properties: {
            title:
              sheet.name
          }

        }

      });

    }

  }

  if (
    requests.length > 0
  ) {

    await api.spreadsheets.batchUpdate({

      spreadsheetId,

      requestBody: {
        requests
      }

    });

    console.log(
      "✅ Missing Google Sheet tabs created."
    );

  }

  /* =====================================================
     ADD HEADERS
  ===================================================== */

  for (
    const sheet of requiredSheets
  ) {

    const headerRange =
      `${sheet.name}!A1`;

    const existing =
      await api.spreadsheets.values.get({

        spreadsheetId,

        range:
          headerRange

      });

    if (
      !existing.data.values?.length
    ) {

      await api.spreadsheets.values.update({

        spreadsheetId,

        range:
          headerRange,

        valueInputOption:
          "RAW",

        requestBody: {

          values: [
            sheet.headers
          ]

        }

      });

      console.log(
        `✅ Added headers to ${sheet.name}`
      );

    }

  }

  console.log(
    "✅ Google Sheets setup complete."
  );
}

/* =====================================================
   ADD TRANSACTION
===================================================== */

export async function addTransaction(
  data
) {

  await ensureSheets();

  const api =
    await getSheets();

  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID;

  await api.spreadsheets.values.append({

    spreadsheetId,

    range:
      "Transactions!A:J",

    valueInputOption:
      "USER_ENTERED",

    requestBody: {

      values: [[

        data.createdAt ||
          new Date().toISOString(),

        data.id ||
          "",

        data.type ||
          "",

        data.amount ??
          "",

        data.currency ||
          "LKR",

        data.description ||
          "",

        data.service ||
          "",

        data.paymentMethod ||
          "",

        data.status ||
          "unknown",

        data.date ||
          ""

      ]]

    }

  });

  console.log(
    "✅ Transaction added to Google Sheets."
  );
}

/* =====================================================
   ADD INVOICE
===================================================== */

export async function addInvoice(
  data
) {

  await ensureSheets();

  const api =
    await getSheets();

  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID;

  await api.spreadsheets.values.append({

    spreadsheetId,

    range:
      "Invoices!A:R",

    valueInputOption:
      "USER_ENTERED",

    requestBody: {

      values: [[

        data.invoiceNumber ||
          "",

        data.customer?.name ||
          "",

        data.customer?.email ||
          "",

        data.customer?.phone ||
          "",

        data.customer?.company ||
          "",

        data.customer?.address ||
          "",

        data.description ||
          "",

        data.quantity ??
          1,

        data.billingCycle ||
          "",

        data.unitPrice ??
          0,

        data.discount ??
          0,

        data.tax ??
          0,

        data.total ??
          0,

        data.currency ||
          "LKR",

        data.status ||
          "",

        data.purchaseDate ||
          "",

        data.expiryDate ||
          "",

        data.createdAt ||
          new Date().toISOString()

      ]]

    }

  });

  console.log(
    "✅ Invoice added to Google Sheets."
  );
}

/* =====================================================
   READ ALL INVOICES
===================================================== */

export async function getAllInvoices() {

  await ensureSheets();

  const api =
    await getSheets();

  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID;

  const response =
    await api.spreadsheets.values.get({

      spreadsheetId,

      range:
        "Invoices!A2:R",

      valueRenderOption:
        "UNFORMATTED_VALUE"

    });

  const rows =
    response.data.values || [];

  return rows.map(
    (row, index) => {

      return {

        invoiceNumber:
          row[0] || "",

        customer: {

          name:
            row[1] || "",

          email:
            row[2] || "",

          phone:
            row[3] || "",

          company:
            row[4] || "",

          address:
            row[5] || ""

        },

        description:
          row[6] || "",

        quantity:
          Number(
            row[7] || 1
          ),

        billingCycle:
          row[8] || "",

        unitPrice:
          Number(
            row[9] || 0
          ),

        discount:
          Number(
            row[10] || 0
          ),

        tax:
          Number(
            row[11] || 0
          ),

        total:
          Number(
            row[12] || 0
          ),

        currency:
          row[13] || "LKR",

        status:
          row[14] || "",

        purchaseDate:
          row[15] || "",

        expiryDate:
          row[16] || "",

        createdAt:
          row[17] || "",

        sheetRow:
          index + 2

      };

    }
  );
}

/* =====================================================
   READ ALL TRANSACTIONS
===================================================== */

export async function getAllTransactions() {

  await ensureSheets();

  const api =
    await getSheets();

  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID;

  const response =
    await api.spreadsheets.values.get({

      spreadsheetId,

      range:
        "Transactions!A2:J",

      valueRenderOption:
        "UNFORMATTED_VALUE"

    });

  const rows =
    response.data.values || [];

  return rows.map(
    (row, index) => {

      return {

        createdAt:
          row[0] || "",

        id:
          row[1] || "",

        type:
          row[2] || "",

        amount:
          Number(
            row[3] || 0
          ),

        currency:
          row[4] || "LKR",

        description:
          row[5] || "",

        service:
          row[6] || "",

        paymentMethod:
          row[7] || "",

        status:
          row[8] || "",

        date:
          row[9] || "",

        sheetRow:
          index + 2

      };

    }
  );
}

/* =====================================================
   FIND CUSTOMER IN GOOGLE SHEETS
===================================================== */

export async function searchInvoices(
  searchText
) {

  const invoices =
    await getAllInvoices();

  const query =
    String(
      searchText || ""
    )
      .trim()
      .toLowerCase();

  if (!query) {
    return [];
  }

  return invoices.filter(
    invoice => {

      const searchable = [

        invoice.invoiceNumber,

        invoice.customer?.name,

        invoice.customer?.email,

        invoice.customer?.phone,

        invoice.customer?.company,

        invoice.customer?.address,

        invoice.description,

        invoice.billingCycle,

        invoice.currency,

        invoice.status

      ]
        .join(" ")
        .toLowerCase();

      return searchable.includes(
        query
      );

    }
  );
}

/* =====================================================
   ADD ORDER
===================================================== */

export async function addOrder(
  data
) {

  await ensureSheets();

  const api =
    await getSheets();

  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID;

  await api.spreadsheets.values.append({

    spreadsheetId,

    range:
      "Orders!A:S",

    valueInputOption:
      "USER_ENTERED",

    requestBody: {

      values: [[

        data.orderNumber ||
          "",

        data.discordUserId ||
          "",

        data.discordUsername ||
          "",

        data.customer?.name ||
          "",

        data.customer?.email ||
          "",

        data.customer?.address ||
          "",

        data.ram ||
          "",

        data.disk ||
          "",

        data.cpu ||
          "",

        data.location ||
          "",

        data.unitPrice ??
          data.price ??
          0,

        data.discountCode ||
          "",

        data.discount ??
          0,

        data.total ??
          0,

        data.paymentMethod ||
          "",

        data.status ||
          "",

        data.invoiceNumber ||
          "",

        data.createdAt ||
          new Date().toISOString(),

        data.confirmedAt ||
          ""

      ]]

    }

  });

  console.log(
    "✅ Order added to Google Sheets."
  );
}

/* =====================================================
   ADD RENEWAL
===================================================== */

export async function addRenewal(
  data
) {

  await ensureSheets();

  const api =
    await getSheets();

  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID;

  await api.spreadsheets.values.append({

    spreadsheetId,

    range:
      "Renewals!A:U",

    valueInputOption:
      "USER_ENTERED",

    requestBody: {

      values: [[

        data.renewalId ||
          "",

        data.sourceOrderNumber ||
          data.orderNumber ||
          "",

        data.discordUserId ||
          "",

        data.discordUsername ||
          "",

        data.customer?.name ||
          "",

        data.customer?.email ||
          "",

        data.serverName ||
          "",

        data.ram ||
          "",

        data.disk ||
          "",

        data.cpu ||
          "",

        data.location ||
          "",

        data.amount ??
          data.price ??
          0,

        data.currency ||
          "LKR",

        data.paymentMethod ||
          "",

        data.status ||
          "",

        data.invoiceNumber ||
          "",

        data.previousExpiryDate ||
          "",

        data.newExpiryDate ||
          "",

        data.createdAt ||
          new Date().toISOString(),

        data.confirmedAt ||
          "",

        data.confirmedBy ||
          ""

      ]]

    }

  });

  console.log(
    "✅ Renewal added to Google Sheets."
  );
}

/* =====================================================
   ADD / UPDATE ACCOUNT
===================================================== */

export async function upsertAccount(
  data
) {

  await ensureSheets();

  const api =
    await getSheets();

  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID;

  const response =
    await api.spreadsheets.values.get({

      spreadsheetId,

      range:
        "Accounts!A2:T",

      valueRenderOption:
        "UNFORMATTED_VALUE"

    });

  const rows =
    response.data.values || [];

  const discordUserId =
    String(
      data.discordUserId || ""
    );

  let existingRow = -1;

  for (
    let i = 0;
    i < rows.length;
    i++
  ) {

    if (
      String(rows[i]?.[0] || "") ===
      discordUserId
    ) {

      existingRow =
        i + 2;

      break;

    }

  }

  const values = [[

    data.discordUserId ||
      "",

    data.discordUsername ||
      "",

    data.customer?.name ||
      data.clientName ||
      "",

    data.customer?.email ||
      data.email ||
      "",

    data.customer?.phone ||
      data.phone ||
      "",

    data.customer?.address ||
      data.address ||
      "",

    data.orderNumber ||
      data.sourceOrderNumber ||
      "",

    data.serverName ||
      "",

    data.ram ||
      "",

    data.disk ||
      "",

    data.cpu ||
      "",

    data.location ||
      "",

    data.amount ??
      data.price ??
      0,

    data.currency ||
      "LKR",

    data.accountStatus ||
      data.status ||
      "active",

    data.paymentStatus ||
      "Paid",

    data.lastPaymentDate ||
      data.confirmedAt ||
      "",

    data.lastInvoiceNumber ||
      data.invoiceNumber ||
      "",

    data.expiryDate ||
      "",

    data.updatedAt ||
      new Date().toISOString()

  ]];

  if (
    existingRow !== -1
  ) {

    await api.spreadsheets.values.update({

      spreadsheetId,

      range:
        `Accounts!A${existingRow}:T${existingRow}`,

      valueInputOption:
        "USER_ENTERED",

      requestBody: {
        values
      }

    });

    console.log(
      `✅ Account updated in Google Sheets: ${discordUserId}`
    );

  } else {

    await api.spreadsheets.values.append({

      spreadsheetId,

      range:
        "Accounts!A:T",

      valueInputOption:
        "USER_ENTERED",

      requestBody: {
        values
      }

    });

    console.log(
      `✅ Account added to Google Sheets: ${discordUserId}`
    );

  }
}

/* =====================================================
   FIND ACCOUNT
===================================================== */

export async function getAccount(
  discordUserId
) {

  await ensureSheets();

  const api =
    await getSheets();

  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID;

  const response =
    await api.spreadsheets.values.get({

      spreadsheetId,

      range:
        "Accounts!A2:T",

      valueRenderOption:
        "UNFORMATTED_VALUE"

    });

  const rows =
    response.data.values || [];

  const index =
    rows.findIndex(
      row =>
        String(row?.[0] || "") ===
        String(discordUserId || "")
    );

  if (
    index === -1
  ) {
    return null;
  }

  const row =
    rows[index];

  return {

    discordUserId:
      row[0] || "",

    discordUsername:
      row[1] || "",

    clientName:
      row[2] || "",

    email:
      row[3] || "",

    phone:
      row[4] || "",

    address:
      row[5] || "",

    orderNumber:
      row[6] || "",

    serverName:
      row[7] || "",

    ram:
      row[8] || "",

    disk:
      row[9] || "",

    cpu:
      row[10] || "",

    location:
      row[11] || "",

    amount:
      Number(row[12] || 0),

    currency:
      row[13] || "LKR",

    accountStatus:
      row[14] || "",

    paymentStatus:
      row[15] || "",

    lastPaymentDate:
      row[16] || "",

    lastInvoiceNumber:
      row[17] || "",

    expiryDate:
      row[18] || "",

    updatedAt:
      row[19] || "",

    sheetRow:
      index + 2

  };
}

/* =====================================================
   MANUAL SETUP
===================================================== */

export async function setupGoogleSheets() {

  await ensureSheets();

}