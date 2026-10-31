/**
 * Sign in to a running gateway the way the browser does with BSV Desktop,
 * using @bsv/sdk's ProtoWallet in place of the wallet. Returns the session cookie.
 */
const { ProtoWallet, PrivateKey } = require('@bsv/sdk');

async function login(baseUrl, privateKey = PrivateKey.fromRandom(), role) {
  const wallet = new ProtoWallet(privateKey);
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });

  const challenge = await (await fetch(`${baseUrl}/api/auth/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const { signature } = await wallet.createSignature({
    data: Array.from(Buffer.from(challenge.message, 'utf8')),
    protocolID: challenge.protocolID,
    keyID: challenge.keyID,
    counterparty: 'anyone'
  });
  const res = await fetch(`${baseUrl}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityKey, nonce: challenge.nonce, signature })
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];

  if (role) {
    await fetch(`${baseUrl}/api/me/role`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ role }) });
  }
  return { cookie, identityKey, privateKey, wallet };
}

module.exports = { login };
