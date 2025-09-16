export const validateTumipaySignature = (body, signature, clientToken) => {
  const message = JSON.stringify({
    token: clientToken,
    ticket: body.top_ticket,
    reference: body.top_reference,
  });
  const expected = crypto.createHash("sha256").update(message).digest("hex");
  return expected === signature;
}
