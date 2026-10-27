# Peer file transfers

File contents are encrypted and transferred between browsers over WebRTC. The app server stores only the encrypted offer and transfer metadata. STUN is tried first; a TURN relay is needed when NATs or firewalls prevent a direct connection.

## Self-hosted TURN setup

The app now requests short-lived TURN credentials from the authenticated backend endpoint `/v1/turn/credentials`. The shared secret stays on the backend; it is never included in the frontend bundle.

1. Provision a public VPS with a public IP address and a DNS name such as `turn.example.com`.
2. Install Coturn on the VPS and configure `/etc/turnserver.conf`:

   ```ini
   listening-port=3478
   fingerprint
   use-auth-secret
   static-auth-secret=REPLACE_WITH_A_RANDOM_SECRET
   realm=turn.example.com
   min-port=49160
   max-port=49200
   no-loopback-peers
   no-multicast-peers
   ```

   Generate the shared secret on the server with `openssl rand -hex 32`. If the VPS is behind NAT, configure Coturn's `external-ip` with its public/private address mapping.

3. Allow inbound **UDP and TCP 3478** and **UDP 49160-49200** in both the VPS firewall and provider firewall. Add TCP 5349 and a valid TLS certificate only if you configure a `turns:` URL.
4. Configure the app backend's private environment:

   ```env
   TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
   TURN_SHARED_SECRET=THE_SAME_RANDOM_SECRET_AS_COTURN
   TURN_CREDENTIAL_TTL_SECONDS=600
   ```

   The backend URL list and Coturn `realm`/secret must match the relay setup. Restart the backend after setting these values. The TTL is limited to 60–3600 seconds.

5. Rebuild/redeploy the frontend only if its normal API URL changed. The frontend fetches temporary credentials from the backend when a transfer starts; no TURN password belongs in a `VITE_` variable.

## Troubleshooting

- Verify `turn.example.com` resolves to the VPS public IP.
- Confirm both firewalls allow the TURN listener and relay UDP range.
- Test file sharing between devices on different networks. A LAN-only test does not prove that TURN is being used.
- If direct connections still fail, verify the backend is reachable at `/v1/turn/credentials`, that both server configurations use the same secret, and that the browser's network permits UDP. Some restricted networks may also require a TLS TURN listener.

TURN relays encrypted WebRTC packets while the peers exchange the file; the app server still does not store file bytes. A public VPS or TURN relay cannot be provisioned from this source workspace, so these deployment steps must be completed on your host.
