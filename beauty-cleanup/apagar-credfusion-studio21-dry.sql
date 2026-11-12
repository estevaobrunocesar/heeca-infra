-- ENSAIO: mesma exclusão, mas termina em ROLLBACK (nada é gravado). Rode antes da versão real.
BEGIN;
\echo '--- antes'
SELECT t.slug, t."businessName", (SELECT count(*) FROM "Client" c WHERE c."tenantId" = t.id) AS clientes FROM "Tenant" t ORDER BY t."createdAt";
DELETE FROM "Tenant" WHERE slug IN ('credfusion', 'studio21');
\echo '--- depois (deve restar só studio21-2; será desfeito)'
SELECT t.slug, t."businessName", (SELECT count(*) FROM "Client" c WHERE c."tenantId" = t.id) AS clientes FROM "Tenant" t ORDER BY t."createdAt";
ROLLBACK;
