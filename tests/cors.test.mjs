import test from 'node:test';
import assert from 'node:assert/strict';
import { corsHeaders, isAdminPath } from '../src/cors.mjs';

test('CORS solo se concede a las rutas de administración', () => {
  assert.equal(isAdminPath('/api/admin/invitations'), true);
  assert.equal(isAdminPath('/api/admin'), true);
  assert.equal(isAdminPath('/api/invitation/abc'), false);
  assert.equal(isAdminPath('/api/administrador'), false);
  assert.deepEqual(corsHeaders('/api/invitation/abc123'), {});
  const h = corsHeaders('/api/admin/events');
  assert.equal(h['access-control-allow-origin'], '*');
  assert.match(h['access-control-allow-headers'], /authorization/);
});
