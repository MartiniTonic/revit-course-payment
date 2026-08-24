/*
 * ==========================================
 * REVIT COURSE PAYMENT
 * Cloudflare Worker + T-Bank
 * ==========================================
 */

const TBANK_URL = "https://rest-api-test.tinkoff.ru/v2/Init";

/*
 * ==========================================
 * CORS
 * ==========================================
 */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=UTF-8",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(),
  });
}

/*
 * ==========================================
 * SHA-256
 * ==========================================
 */

async function sha256(text) {
  const data = new TextEncoder().encode(text);

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  const hashArray = Array.from(
    new Uint8Array(hashBuffer)
  );

  return hashArray
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

/*
 * ==========================================
 * T-BANK TOKEN
 * ==========================================
 */

async function generateToken(params, password) {
  const tokenParams = [];

  for (const [key, value] of Object.entries(params)) {

    if (
      value !== null &&
      value !== undefined &&
      typeof value !== "object" &&
      key !== "Token"
    ) {
      tokenParams.push({
        key,
        value: String(value),
      });
    }
  }

  tokenParams.push({
    key: "Password",
    value: password,
  });

  tokenParams.sort((a, b) =>
    a.key.localeCompare(b.key)
  );

  const stringToHash = tokenParams
    .map(item => item.value)
    .join("");

  return sha256(stringToHash);
}

/*
 * ==========================================
 * ORDER ID
 * ==========================================
 */

function createOrderId() {

  const randomPart = crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 8);

  return `REVIT-${Date.now()}-${randomPart}`;
}

/*
 * ==========================================
 * CLOUDFLARE WORKER
 * ==========================================
 */

export default {

  async fetch(request, env) {

    /*
     * CORS
     */

    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });

    }

    const url = new URL(request.url);

    /*
     * ========================================
     * SERVER STATUS
     * ========================================
     */

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {

      return jsonResponse({
        success: true,
        service: "revit-course-payment",
        status: "online",
        environment: "test",
      });

    }

    /*
     * ========================================
     * CREATE PAYMENT
     * ========================================
     */

    if (
      request.method === "POST" &&
      url.pathname === "/create-payment"
    ) {

      try {

        const TERMINAL_KEY =
          env.TBANK_TERMINAL_KEY;

        const PASSWORD =
          env.TBANK_PASSWORD;

        /*
         * Проверяем секреты
         */

        if (!TERMINAL_KEY) {

          return jsonResponse({
            success: false,
            error: "TBANK_TERMINAL_KEY is not configured",
          }, 500);

        }

        if (!PASSWORD) {

          return jsonResponse({
            success: false,
            error: "TBANK_PASSWORD is not configured",
          }, 500);

        }

        /*
         * Получаем JSON
         */

        let body;

        try {

          body = await request.json();

        } catch {

          return jsonResponse({
            success: false,
            error: "Некорректный JSON",
          }, 400);

        }

        /*
         * ====================================
         * ФИКСИРОВАННАЯ ЦЕНА КУРСА
         * ====================================
         *
         * Сейчас намеренно фиксируем:
         * 30 000 рублей.
         *
         * Framer не сможет изменить сумму.
         */

        const amountRubles = 30000;

        const amount = 3000000;

        const description =
          "Курс Revit — 30 000 ₽";

        /*
         * OrderId
         */

        const orderId =
          createOrderId();

        /*
         * ====================================
         * REQUEST TO T-BANK
         * ====================================
         */

        const paymentRequest = {

          TerminalKey:
            TERMINAL_KEY,

          Amount:
            amount,

          OrderId:
            orderId,

          Description:
            description,

          Language:
            "ru",

          PayType:
            "O",

        };

        /*
         * Token
         */

        paymentRequest.Token =
          await generateToken(
            paymentRequest,
            PASSWORD
          );

        /*
         * ====================================
         * SEND TO T-BANK
         * ====================================
         */

        const response = await fetch(
          TBANK_URL,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
            },

            body: JSON.stringify(
              paymentRequest
            ),

            cache: "no-store",
          }
        );

        const text =
          await response.text();

        let result;

        try {

          result = JSON.parse(text);

        } catch {

          result = {
            raw: text,
          };

        }

        /*
         * ====================================
         * LOG
         * ====================================
         */

        console.log(
          "T-Bank HTTP status:",
          response.status
        );

        console.log(
          "T-Bank response:",
          result
        );

        /*
         * ====================================
         * HTTP ERROR
         * ====================================
         */

        if (!response.ok) {

          return jsonResponse({

            success: false,

            error:
              "T-Bank HTTP error",

            httpStatus:
              response.status,

            details:
              result,

          }, 502);

        }

        /*
         * ====================================
         * T-BANK ERROR
         * ====================================
         */

        if (!result.Success) {

          return jsonResponse({

            success: false,

            error:
              result.Message ||
              result.Details ||
              "T-Bank не создал платеж",

            tbank:
              result,

          }, 400);

        }

        /*
         * ====================================
         * SUCCESS
         * ====================================
         */

        return jsonResponse({

          success: true,

          paymentId:
            result.PaymentId,

          orderId:
            result.OrderId,

          paymentUrl:
            result.PaymentURL,

        });

      } catch (error) {

        console.error(
          "Worker error:",
          error
        );

        return jsonResponse({

          success: false,

          error:
            "Внутренняя ошибка сервера",

          details:
            error?.message ||
            String(error),

        }, 500);

      }

    }

    /*
     * ========================================
     * 404
     * ========================================
     */

    return jsonResponse({

      success: false,

      error: "Not found",

    }, 404);

  },

};
