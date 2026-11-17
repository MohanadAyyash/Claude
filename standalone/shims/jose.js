// The standalone (browser) edition has no Microsoft 365 link: the OAuth callback and client secret need a real server. `jose` is
// therefore not bundled, and requiring it fails, so modules/microsoft365.js reports the link as unavailable (fail closed).
throw new Error('jose is not part of the standalone edition');
