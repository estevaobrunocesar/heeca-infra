<?php
// Garante backup diário (03:00 UTC) de TODO Postgres para o R2 heeca-backups, guardando os últimos 7 (sobrescreve o mais antigo); 1 cópia local.
$template = \App\Models\ScheduledDatabaseBackup::find(1);
foreach (\App\Models\StandalonePostgresql::all() as $db) {
  try {
    $b = \App\Models\ScheduledDatabaseBackup::where('database_id', $db->id)->where('database_type', get_class($db))->first();
    $novo = false;
    if (!$b) {
      $b = $template->replicate(['uuid']);
      $b->uuid = (string) \Illuminate\Support\Str::uuid();
      $b->database_id = $db->id; $b->database_type = get_class($db); $b->team_id = $db->team()->id ?? $template->team_id;
      $novo = true;
    }
    $b->frequency = '0 3 * * *'; $b->enabled = true; $b->save_s3 = true; $b->s3_storage_id = 1;
    $b->database_backup_retention_amount_locally = 1; $b->database_backup_retention_days_locally = 0;
    $b->database_backup_retention_amount_s3 = 7; $b->database_backup_retention_days_s3 = 7;
    // O modelo (#1) é o do portal: sem isto todo banco replicado tentava dump de `heeca_portal` e falhava (20/09 a 09/10, 18 de 21 sem nenhum backup bom).
    $b->databases_to_backup = $db->postgres_db; $b->dump_all = false;
    $b->save();
    echo ($novo ? '+ ' : '= '), $db->name, ' (', $db->postgres_db, ')', PHP_EOL;
    // BACKUP_NOW=1: além de corrigir, dispara um backup agora (para validar de ponta a ponta sem esperar as 03:00 UTC).
    if (getenv('BACKUP_NOW')) { \App\Jobs\DatabaseBackupJob::dispatch($b); echo '  > backup disparado', PHP_EOL; }
  } catch (\Throwable $e) { echo '! ', $db->name, ': ', $e->getMessage(), PHP_EOL; }
}
