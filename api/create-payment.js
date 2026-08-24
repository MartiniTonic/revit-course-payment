const TBANK_URL = "https://rest-api-test.tinkoff.ru/v2/Init";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function generateToken(params, password) {
  const values = Object.entries(params)
    .filter(([key, value]) =>
      key !== "Token" &&
      value !== null &&
      value !== undefined &&
      typeof value !== "object"
    )
    .map(([key, value]) => ({
      key,
      value: String(value),
    }));

  values.push({
    key: "Password",
    value: password,
  });

  values.sort((a, b) => a.key.localeCompare(b.key));

  const stringToHash = values
    .map(item => item.value)
    .join("");

  return sha256(stringToHash);
}

function createOrderId() {
  return `REVIT-${Date.now()}-${crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 8)}`;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
    return;
  }

  try {
    const terminalKey = process.env.TBANK_TERMINAL_KEY;
    const password = process.env.TBANK_PASSWORD;

    if (!terminalKey) {
      res.status(500).json({
        success: false,
        error: "TBANK_TERMINAL_KEY is not configured",
      });
      return;
    }

    if (!password) {
      res.status(500).json({
        success: false,
        error: "TBANK_PASSWORD is not configured",
      });
      return;
    }

    const orderId = createOrderId();

    const paymentRequest = {
      TerminalKey: terminalKey,
      Amount: 3000000,
      OrderId: orderId,
      Description: "Курс Revit — 30 000 ₽",
      Language: "ru",
      PayType: "O",
    };

    paymentRequest.Token = await generateToken(
      paymentRequest,
      password
    );

    const response = await fetch(TBANK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(paymentRequest),
    });

    const text = await response.text();

    let result;

    try {
      result = JSON.parse(text);
    } catch {
      result = {
        raw: text,
      };
    }

    console.log("T-Bank status:", response.status);
    console.log("T-Bank response:", result);

    if (!response.ok) {
      res.status(502).json({
        success: false,
        error: "T-Bank HTTP error",
        httpStatus: response.status,
        details: result,
      });
      return;
    }

    if (!result.Success) {
      res.status(400).json({
        success: false,
        error:
          result.Message ||
          result.Details ||
          "T-Bank не создал платеж",
        tbank: result,
      });
      return;
    }

    res.status(200).json({
      success: true,
      paymentId: result.PaymentId,
      orderId: result.OrderId,
      paymentUrl: result.PaymentURL,
    });

  } catch (error) {
    console.error("Vercel error:", error);

    res.status(500).json({
      success: false,
      error: "Внутренняя ошибка сервера",
      details: error?.message || String(error),
    });
  }
}
