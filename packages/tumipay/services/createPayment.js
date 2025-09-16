import axios, { isAxiosError } from 'axios'

export class TumiPayClient {
  #api
  /**
 * Crea una nueva instancia de la clase para interactuar con la API de pagos.
 *
 * @constructor
 * @param {Object} authConfig - Configuración de autenticación para la API.
 * @param {string} authConfig.baseURL - URL base de la API.
 * @param {string} authConfig.apiKey - API Key proporcionada por el proveedor.
 * @param {string} authConfig.username - Nombre de usuario para autenticación básica.
 * @param {string} authConfig.password - Contraseña para autenticación básica.
 */
  constructor({baseURL, apiKey, username, password}) {
    this.#api = axios.create({
      baseURL,
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'Token-Top': apiKey,
        'User-Agent': ''
        // 'User-Agent': 'Tumipay/1.1'
      }
    })
  }

  /**
 * @typedef {Object} Transaction
 * @property {string} reference - Referencia única de la transacción generada.
 * @property {number} amount - Monto de la transacción.
 * @property {string} currency - Código de la moneda en formato ISO 4217 (por ejemplo: "COP").
 * @property {string} payment_method - Método de pago utilizado (por ejemplo: "PSE", "CREDIT_CARD", "ALL_METHODS").
 * @property {string} redirect_url - URL a la que será redirigido el usuario después de completar el pago.
 * @property {string} ipn_url - URL para recibir notificaciones de la transacción (IPN).
 * @property {string} description - Descripción del pago o transacción.



 * @param {Object} payInConfig - Configuración para la creación de un pago.
 * @param {string} [payInConfig.reference] - Referencia única para identificar la transacción.
 * @param {number} [payInConfig.amount] - Monto de la transacción.
 * @param {string} [payInConfig.currency] - Código de moneda en formato ISO 4217 (por ejemplo COP).
 * @param {string} [payInConfig.country] - Código de país en formato ISO 3166-1 alfa-2 (por ejemplo CO).
 * @param {string} [payInConfig.payment_method] - Método de pago (por ejemplo: `CREDIT_CARD`, `PSE`, `ALL_METHODS`).
 * @param {string} [payInConfig.description] - Descripción del pago para identificar la transacción.

 * @param {Object} [payInConfig.customer_data] - Información del cliente asociado a la transacción.
 * @param {string} [payInConfig.customer_data.legal_doc] - Número de documento de identidad del cliente.
 * @param {string} [payInConfig.customer_data.legal_doc_type] - Tipo de documento (por ejemplo: `CC` - Cédula, `NIT` - Número de identificación tributaria).
 * @param {string} [payInConfig.customer_data.phone_code] - Código de país para el teléfono (por ejemplo '57' para Colombia).
 * @param {string} [payInConfig.customer_data.phone_number] - Número de teléfono del cliente.
 * @param {string} [payInConfig.customer_data.email] - Correo electrónico del cliente.
 * @param {string} [payInConfig.customer_data.full_name] - Nombre completo del cliente.
 *
 * @param {number} [payInConfig.expiration_time] - Tiempo de expiración de la transacción en segundos (0 significa sin expiración).
 * @param {string} [payInConfig.ipn_url] - URL para notificaciones de pago (IPN).
 * @param {string} [payInConfig.redirect_url] - URL a la que se redirigirá al cliente después del pago.
 *
 * @typedef {Object} ApiResponse
 * @property {string} code - Código de estado de la operación (por ejemplo: "01" para éxito).
 * @property {string} status - Estado de la operación (por ejemplo: "SUCCESS" o "FAILED").
 * @property {string} message - Mensaje descriptivo del resultado de la operación.
 *
 * @typedef {Object} PaymentData
 * @property {string} ticket - Identificador único del proceso de pago generado.
 * @property {string} date - Fecha y hora en la que se generó el pago, en formato `YYYY-MM-DD HH:mm:ss`.
 * @property {string} payment_url - URL donde el cliente debe realizar el pago.
 * @property {Transaction} transaction - Información detallada de la transacción asociada al pago.
 * @property {PaymentData} data - Datos retornados en caso de éxito, incluyendo la transacción y el link de pago.
 *
 * @returns {Promise<ApiResponse>} Respuesta de la API con información sobre el estado de la transacción y detalles del pago.
 */
  async createPaymentLink(payInConfig) {
    try {
      const response = await this.#api.post('/payin', payInConfig)

      return response.data
    } catch (error) {
      if(isAxiosError(error)) {
        return error.response.data
      }
      return {
        code: '00',
        status: "ERROR",
        message: "Error desconocido",
        error: "REFERENCE_INVALID"
      }
    }
  }
}

const d = new TumiPayClient({})