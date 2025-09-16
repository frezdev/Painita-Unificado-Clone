import 'dotenv/config'

export const TUMIPAY_KEY = process.env.TUMIPAY_KEY || ''
export const TUMIPAY_BASE = process.env.TUMIPAY_BASE || ''
export const TUMIPAY_PASS = process.env.TUMIPAY_PASS || ''
export const TUMIPAY_USER = process.env.TUMIPAY_USER || ''
export const TUMIPAY_NOTIFY_URL = process.env.TUMIPAY_NOTIFY_URL || ''
export const TUMIPAY_PAYMENT_METHOD = process.env.TUMIPAY_PAYMENT_METHOD || 'PSE'
export const TUMIPAY_RETURN_URL = process.env.TUMIPAY_RETURN_URL || ''

export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''
export const CRM_BASE = process.env.CRM_BASE
export const CRM_HOSTPORT = process.env.CRM_HOSTPORT
export const CRM_HOST = process.env.CRM_HOST
export const CRM_PORT = process.env.CRM_PORT

export const LEGACY_WEB_DIR = process.env.LEGACY_WEB_DIR
export const EXPIRED_TIME_LINK = process.env.EXPIRED_TIME_LINK || 1
export const FETCH_TIMEOUT_MS = process.env.FETCH_TIMEOUT_MS

export const DEV_OTP_CODE = process.env.DEV_OTP_CODE
export const OTP_BYPASS = process.env.OTP_BYPASS
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN
export const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID
export const TWILIO_SERVICE_SID = process.env.TWILIO_SERVICE_SID

export const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '+57'
export const LEGACY_INJECT_ADAPTER = process.env.LEGACY_INJECT_ADAPTER

export const PORT = process.env.PORT