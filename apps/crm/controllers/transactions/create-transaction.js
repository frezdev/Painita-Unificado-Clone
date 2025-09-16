import { pool, readFileDB, writeFileDB } from "../../db.js";
import { generateReferenceId } from "../../utils/generate-reference-id.js";

/**
 * CREATE TABLE IF NOT EXISTS transactions (
    id text primary key NOT NULL,
    customer_id text COLLATE pg_catalog."default" NOT NULL,
    coustomer_email character varying(120) COLLATE pg_catalog."default" NOT NULL,
    status text COLLATE pg_catalog."default" NOT NULL DEFAULT 'pending'::text,
    amount numeric,
    created_at timestamp with time zone NOT NULL DEFAULT now()
  );
 * @param {Object} data
 * @param {string} [data.customer_id]
 * @param {string} [data.coustomer_email]
 * @param {string} [data.status]
 * @param {munber} [data.amount]
 *
 * @typedef {Object} ReturnedData
 * @property {Data} data
 * @property {boolean} ok
 *
 * @typedef {Object} Data
 * @property {string} id
 * @property {string} customer_id
 * @property {string} coustomer_email
 * @property {string} status
 * @property {string} created_at
  *
 * @returns {Promise<ReturnedData>}
 * CREATE TABLE IF NOT EXISTS transactions (
    id text primary key NOT NULL,
    customer_id text COLLATE pg_catalog."default" NOT NULL,
    coustomer_email character varying(120) COLLATE pg_catalog."default" NOT NULL,
    status text COLLATE pg_catalog."default" NOT NULL DEFAULT 'pending'::text,
    amount numeric,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
 */
export const createTransaction = async ({amount, coustomer_email, customer_id}) => {
  try {
    const id = await generateReferenceId({customer_id, amount})

    const { rows } = await pool.query(`
        insert into transactions(id,customer_id,coustomer_email,amount)
        values ($1,$2,$3,$4)
        returning id, customer_id, coustomer_email, amount, status, created_at
      `,
      [id, customer_id, coustomer_email, amount]
    );
    return {ok: true, data: rows[0]}
  } catch (error) {
    console.log({error})
    return {ok: false, data: null}
  }
}

/**
 * @param {Object} data
 * @param {string} [data.customer_id]
 * @param {string} [data.coustomer_email]
 * @param {string} [data.status]
 * @param {munber} [data.amount]
 *
 * @typedef {Object} ReturnedData
 * @property {Data} data
 * @property {boolean} ok
 *
 * @typedef {Object} Data
 * @property {string} id
 * @property {string} customer_id
 * @property {string} coustomer_email
 * @property {string} status
 * @property {string} created_at
  *
 * @returns {Promise<ReturnedData>}
 */
export const createTransactionMock = async (data) => {
  try {
    const db = readFileDB()

    db.transactions = db.transactions || []
    const created_at = new Date().toISOString()

    const id = await generateReferenceId({customer_id: data.customer_id, amount: data.amount})
    db.transactions.push({id, ...data, created_at})
    writeFileDB(db);

    const current = db.transactions.at(-1)
    return {ok: true, data: current}
  } catch (error) {
    return {ok: false, data: null}
  }
}