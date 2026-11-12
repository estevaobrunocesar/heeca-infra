-- Beauty (produção): apaga os estabelecimentos de teste `credfusion` e `studio21` (NÃO o `studio21-2`).
-- As 23 chaves estrangeiras para "Tenant" são ON DELETE CASCADE: apagar a linha do Tenant leva clientes, agendamentos, pacotes etc.
-- Uso (no servidor, dentro do banco do Beauty; sempre rode primeiro a versão -dry.sql):
--   docker exec -i mvnotz9rj9sermmw4yvpivcm sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < apagar-credfusion-studio21.sql
-- Backup feito antes: /root/beauty-backups/beauty-before-cleanup-*.dump (pg_restore para voltar).
BEGIN;
\echo '--- antes'
SELECT t.slug, t."businessName", (SELECT count(*) FROM "Client" c WHERE c."tenantId" = t.id) AS clientes FROM "Tenant" t ORDER BY t."createdAt";
DELETE FROM "Tenant" WHERE slug IN ('credfusion', 'studio21');
\echo '--- depois (deve restar só studio21-2)'
SELECT t.slug, t."businessName", (SELECT count(*) FROM "Client" c WHERE c."tenantId" = t.id) AS clientes FROM "Tenant" t ORDER BY t."createdAt";
COMMIT;
