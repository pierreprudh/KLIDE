#!/usr/bin/env bash
# One local identity, kept in the login Keychain across rebuilds/checkouts.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS only' >&2; exit 1; }

IDENTITY='Klide Local Development'
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
if security find-identity -v -p codesigning "$KEYCHAIN" | grep -Fq "\"$IDENTITY\""; then
  echo "$IDENTITY is already installed; keeping the existing certificate."
  exit 0
fi
# Never silently replace an existing certificate: doing so loses app identity.
if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "An existing $IDENTITY certificate needs repair in Keychain Access; refusing to replace it." >&2
  exit 1
fi

umask 077
WORK_DIR=$(mktemp -d -t klide-signing)
trap 'rm -rf "$WORK_DIR"' EXIT
cat > "$WORK_DIR/openssl.cnf" <<'EOF'
[req]
distinguished_name = subject
x509_extensions = extensions
prompt = no
[subject]
CN = Klide Local Development
[extensions]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
openssl req -new -newkey rsa:3072 -nodes -x509 -sha256 -days 3650 \
  -config "$WORK_DIR/openssl.cnf" -keyout "$WORK_DIR/key.pem" -out "$WORK_DIR/cert.pem" 2>/dev/null
# Use a temporary random import password; Keychain rejects some PKCS#12 files
# with empty passwords. All export material is removed on exit.
openssl rand -hex 24 > "$WORK_DIR/password"
openssl pkcs12 -export -legacy -macalg sha1 -inkey "$WORK_DIR/key.pem" -in "$WORK_DIR/cert.pem" \
  -out "$WORK_DIR/identity.p12" -passout "file:$WORK_DIR/password"
security import "$WORK_DIR/identity.p12" -k "$KEYCHAIN" -P "$(cat "$WORK_DIR/password")" -T /usr/bin/codesign
# Trust only this certificate for code signing, in this user's trust store.
# macOS may request authentication here. This grants no SSL/root-CA trust.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK_DIR/cert.pem"
security find-identity -v -p codesigning "$KEYCHAIN" | grep -F "\"$IDENTITY\""
echo 'Local signing is ready. npm run tauri build will reuse this identity.'
