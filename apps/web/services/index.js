import { TumiPayClient } from "@painita/tumipay/services/createPayment.js";
import { TUMIPAY_BASE, TUMIPAY_KEY, TUMIPAY_PASS, TUMIPAY_USER } from "../config/env.js";

export const tumiPay = new TumiPayClient({
  baseURL:  TUMIPAY_BASE,
  apiKey: TUMIPAY_KEY,
  password: TUMIPAY_PASS,
  username: TUMIPAY_USER
})