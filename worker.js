/*
 * ==========================================
 * REVIT COURSE PAYMENT
 * Cloudflare Worker + T-Bank
 * ==========================================
 */

const TBANK_URL = "https://securepay.tinkoff.ru/v2/Init";

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
 * ГЕНЕРАЦИЯ TOKEN ДЛЯ Т-БАНКА
 * ==========================================
 *
 * В Token участвуют только параметры
 * верхнего уровня.
 *
 * Вложенные объекты и массивы
 * не участвуют.
 *
 * Password добавляется отдельно.
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

  return await sha256(stringToHash);
}

/*
 * ==========================================
 * УНИКАЛЬНЫЙ ORDER ID
 * ==========================================
 */

function createOrderId() {
  const randomPart = crypto.randomUUID()
    .replace(/-/g, "")
    .slice(0, 8);

  return `REVIT-${Date.now()}-${randomPart}`;
}

/*
 * ==========================================
 * ЗАПРОС К Т-БАНКУ
 * ==========================================
 */

async function requestToTBank(data) {
  const response = await fetch(TBANK_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify(data),
  });

  const text = await response.text();

  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = {
      raw: text,
    };
  }

  return {
    statusCode: response.status,
    body,
  };
}

/*
 * ==========================================
 * CLOUDFLARE WORKER
 * ==========================================
 */

export default {
  async fetch(request, env) {

    /*
     * ========================================
     * OPTIONS / CORS
     * ========================================
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
     * ПРОВЕРКА СЕРВЕРА
     * GET /
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
      });
    }

    /*
     * ========================================
     * СОЗДАНИЕ ПЛАТЕЖА
     * POST /create-payment
     * ========================================
     *
     * Framer отправляет:
     *
     * {
     *   "amount": 150000,
     *   "description": "Курс Revit"
     * }
     *
     * amount указывается в рублях.
     */

    if (
      request.method === "POST" &&
      url.pathname === "/create-payment"
    ) {

      try {

        /*
         * Получаем секреты
         * из Cloudflare Environment
         */

        const TERMINAL_KEY =
          env.TBANK_TERMINAL_KEY;

        const PASSWORD =
          env.TBANK_PASSWORD;

        /*
         * Проверяем наличие секретов
         */

        if (!TERMINAL_KEY) {
          return jsonResponse(
            {
              success: false,
              error:
                "TBANK_TERMINAL_KEY is not configured",
            },
            500
          );
        }

        if (!PASSWORD) {
          return jsonResponse(
            {
              success: false,
              error:
                "TBANK_PASSWORD is not configured",
            },
            500
          );
        }

        /*
         * Читаем JSON от Framer
         */

        let body;

        try {
          body = await request.json();
        } catch {
          return jsonResponse(
            {
              success: false,
              error: "Некорректный JSON",
            },
            400
          );
        }

        /*
         * Получаем сумму
         */

        const amountRubles =
          Number(body.amount);

        const description =
          body.description ||
          "Оплата курса Revit";

        /*
         * Проверяем сумму
         */

        if (
          !Number.isFinite(amountRubles) ||
          amountRubles <= 0
        ) {
          return jsonResponse(
            {
              success: false,
              error: "Некорректная сумма",
            },
            400
          );
        }

        /*
         * Переводим рубли в копейки
         */

        const amount =
          Math.round(amountRubles * 100);

        /*
         * Создаем OrderId
         */

        const orderId =
          createOrderId();

        /*
         * Формируем запрос Т-Банку
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
         * Создаем Token
         */

        paymentRequest.Token =
          await generateToken(
            paymentRequest,
            PASSWORD
          );

        /*
         * Отправляем запрос
         * в Т-Банк
         */

        const result =
          await requestToTBank(
            paymentRequest
          );

        /*
         * Проверяем HTTP-ответ
         */

        if (
          result.statusCode < 200 ||
          result.statusCode >= 300
        ) {

          console.error(
            "T-Bank HTTP error:",
            result.statusCode,
            result.body
          );

          return jsonResponse(
            {
              success: false,
              error: "T-Bank API error",
              details: result.body,
            },
            502
          );
        }

        /*
         * Проверяем ответ Т-Банка
         */

        if (!result.body.Success) {

          console.error(
            "T-Bank payment error:",
            result.body
          );

          return jsonResponse(
            {
              success: false,

              error:
                result.body.Message ||
                result.body.Details ||
                "Т-Банк не создал платеж",

              tbank:
                result.body,
            },
            400
          );
        }

        /*
         * УСПЕШНО
         *
         * Возвращаем Framer
         * ссылку PaymentURL
         */

        return jsonResponse({
          success: true,

          paymentId:
            result.body.PaymentId,

          orderId:
            result.body.OrderId,

          paymentUrl:
            result.body.PaymentURL,
        });

      } catch (error) {

        console.error(
          "Server error:",
          error
        );

        return jsonResponse(
          {
            success: false,

            error:
              "Внутренняя ошибка сервера",

            details:
              error?.message ||
              String(error),
          },
          500
        );
      }
    }

    /*
     * ========================================
     * НЕИЗВЕСТНЫЙ URL
     * ========================================
     */

    return jsonResponse(
      {
        success: false,
        error: "Not found",
      },
      404
    );
  },
};
