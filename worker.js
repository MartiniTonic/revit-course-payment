const express = require("express");
const crypto = require("crypto");
const https = require("https");

const app = express();

app.use(express.json());

/*
 * ==========================================
 * НАСТРОЙКИ
 * ==========================================
 */

const PORT = process.env.PORT || 3000;

const TBANK_URL = "https://securepay.tinkoff.ru/v2/Init";

const TERMINAL_KEY = process.env.TBANK_TERMINAL_KEY;
const PASSWORD = process.env.TBANK_PASSWORD;


/*
 * ==========================================
 * CORS
 * ==========================================
 */

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});


/*
 * ==========================================
 * ГЕНЕРАЦИЯ TOKEN ДЛЯ Т-БАНКА
 * ==========================================
 */

function generateToken(params) {
  const tokenParams = [];

  for (const [key, value] of Object.entries(params)) {
    // В Token участвуют только параметры
    // верхнего уровня.
    if (
      value !== null &&
      value !== undefined &&
      typeof value !== "object" &&
      key !== "Token"
    ) {
      tokenParams.push({
        key,
        value: String(value)
      });
    }
  }

  // Добавляем пароль терминала
  tokenParams.push({
    key: "Password",
    value: PASSWORD
  });

  // Сортировка по ключу
  tokenParams.sort((a, b) => a.key.localeCompare(b.key));

  // Склеиваем только значения
  const stringToHash = tokenParams
    .map(item => item.value)
    .join("");

  // SHA-256
  return crypto
    .createHash("sha256")
    .update(stringToHash, "utf8")
    .digest("hex");
}


/*
 * ==========================================
 * HTTPS ЗАПРОС К Т-БАНКУ
 * ==========================================
 */

function requestToTBank(data) {
  return new Promise((resolve, reject) => {

    const url = new URL(TBANK_URL);

    const postData = JSON.stringify(data);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },

      /*
       * Используем российские доверенные
       * сертификаты, которые мы добавили
       * в переменные окружения.
       */

      ca: [
        process.env.RUSSIAN_TRUSTED_ROOT_CA,
        process.env.RUSSIAN_TRUSTED_SUB_CA
      ]
        .filter(Boolean)
        .join("\n")
    };


    const request = https.request(options, (response) => {

      let body = "";

      response.setEncoding("utf8");

      response.on("data", chunk => {
        body += chunk;
      });

      response.on("end", () => {

        let parsed;

        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = {
            raw: body
          };
        }

        resolve({
          statusCode: response.statusCode,
          body: parsed
        });
      });
    });


    request.on("error", error => {
      reject(error);
    });


    request.write(postData);
    request.end();
  });
}


/*
 * ==========================================
 * ПРОВЕРКА СЕРВЕРА
 * ==========================================
 */

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "revit-course-payment",
    status: "online"
  });
});


/*
 * ==========================================
 * СОЗДАНИЕ ПЛАТЕЖА
 * ==========================================
 *
 * POST /create-payment
 *
 * Framer отправляет:
 *
 * {
 *   "amount": 150000,
 *   "description": "Курс Revit"
 * }
 *
 * amount указывается в рублях.
 *
 * Например:
 *
 * 150000 = 150 000 ₽
 *
 */


app.post("/create-payment", async (req, res) => {

  try {

    if (!TERMINAL_KEY) {
      return res.status(500).json({
        success: false,
        error: "TBANK_TERMINAL_KEY is not configured"
      });
    }

    if (!PASSWORD) {
      return res.status(500).json({
        success: false,
        error: "TBANK_PASSWORD is not configured"
      });
    }


    /*
     * Получаем данные от Framer
     */

    const amountRubles = Number(req.body.amount);

    const description =
      req.body.description ||
      "Оплата курса Revit";


    /*
     * Проверяем сумму
     */

    if (!Number.isFinite(amountRubles) || amountRubles <= 0) {
      return res.status(400).json({
        success: false,
        error: "Некорректная сумма"
      });
    }


    /*
     * Перевод рублей в копейки
     */

    const amount = Math.round(amountRubles * 100);


    /*
     * Создаем уникальный OrderId
     */

    const orderId =
      "REVIT-" +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex");


    /*
     * Формируем запрос Т-Банку
     */

    const paymentRequest = {

      TerminalKey: TERMINAL_KEY,

      Amount: amount,

      OrderId: orderId,

      Description: description,

      Language: "ru",

      PayType: "O"

    };


    /*
     * Формируем Token
     */

    paymentRequest.Token =
      generateToken(paymentRequest);


    /*
     * Отправляем запрос Т-Банку
     */

    const result =
      await requestToTBank(paymentRequest);


    /*
     * Если Т-Банк вернул ошибку
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

      return res.status(502).json({
        success: false,
        error: "T-Bank API error",
        details: result.body
      });
    }


    /*
     * Проверяем ответ Т-Банка
     */

    if (!result.body.Success) {

      console.error(
        "T-Bank payment error:",
        result.body
      );

      return res.status(400).json({
        success: false,
        error:
          result.body.Message ||
          result.body.Details ||
          "Т-Банк не создал платеж",
        tbank: result.body
      });
    }


    /*
     * Успешно.
     *
     * PaymentURL — ссылка,
     * на которую нужно отправить покупателя.
     */

    return res.json({

      success: true,

      paymentId:
        result.body.PaymentId,

      orderId:
        result.body.OrderId,

      paymentUrl:
        result.body.PaymentURL
    });


  } catch (error) {

    console.error(
      "Server error:",
      error
    );

    return res.status(500).json({

      success: false,

      error:
        "Внутренняя ошибка сервера",

      details:
        error.message
    });
  }
});


/*
 * ==========================================
 * ЗАПУСК
 * ==========================================
 */

app.listen(PORT, () => {

  console.log(
    `Payment server started on port ${PORT}`
  );

});
