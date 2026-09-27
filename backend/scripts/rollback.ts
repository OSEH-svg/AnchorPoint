#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { PrismaClient } from '@prisma/client';
import RollbackGenerator from './generate-rollback';

/**
 * Rollback Verification Script
 *
 * Checks foreign key integrity BEFORE applying a rollback SQL file.
 * Usage:
 *   ts-node scripts/rollback.ts [migration_name] [--force] [--dry-run]
 *
 * Options:
 *   migration_name  Target migration directory name (defaults to latest)
 *   --force         Skip confirmation prompt and apply even with FK violations
 *   --dry-run       Report FK check results without applying the rollback
 */

interface FKViolation {
  referencingTable: string;
  referencingColumn: string;
  referencedTable: string;
  referencedColumn: string;
  affectedRowCount: number;
}

interface FKRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface TableRow {
  name: string;
}

interface CountRow {
  count: number;
}

class RollbackVerifier {
  private prisma: PrismaClient;
  private migrationsDir: string;

  constructor() {
    this.prisma = new PrismaClient();
    this.migrationsDir = path.join(__dirname, '../prisma/migrations');
  }

  async run(migrationName?: string, force = false, dryRun = false): Promise<void> {
    console.log('🔍 Migration Rollback Verifier\n' + '='.repeat(60));

    try {
      // 1. Resolve migration and locate/generate rollback.sql
      const resolvedMigration = this.resolveMigration(migrationName);
      if (!resolvedMigration) {
        console.error('❌ No migrations found.');
        process.exit(1);
      }

      console.log(`\n📁 Target migration: ${resolvedMigration}`);
      const rollbackSqlPath = await this.ensureRollbackSql(resolvedMigration);

      const rollbackSql = fs.readFileSync(rollbackSqlPath, 'utf-8');
      console.log(`📄 Rollback SQL: ${rollbackSqlPath}`);

      // 2. Parse which tables will be dropped/altered by the rollback
      const droppedTables = this.extractDroppedTables(rollbackSql);
      if (droppedTables.length > 0) {
        console.log(`\n🗑  Tables to be dropped: ${droppedTables.join(', ')}`);
      }

      // 3. Check FK integrity
      console.log('\n🔎 Checking foreign key integrity...');
      const violations = await this.checkForeignKeyViolations(droppedTables);
      const existingViolations = await this.checkExistingFKViolations();

      this.printIntegrityReport(violations, existingViolations, droppedTables);

      const hasBlockingViolations = violations.some(v => v.affectedRowCount > 0);

      if (dryRun) {
        console.log('\n🧪 Dry-run mode — rollback SQL was NOT applied.');
        process.exit(hasBlockingViolations ? 1 : 0);
      }

      // 4. Confirm before applying
      if (hasBlockingViolations && !force) {
        console.log('\n❌ FK violations detected. Use --force to apply anyway (may break referential integrity).');
        process.exit(1);
      }

      if (!force) {
        const confirmed = await this.confirm(
          `\n⚠️  Apply rollback for migration "${resolvedMigration}"? [y/N] `
        );
        if (!confirmed) {
          console.log('Aborted.');
          process.exit(0);
        }
      } else {
        console.log('\n⚡ --force flag set — skipping confirmation prompt.');
      }

      // 5. Apply rollback SQL
      await this.applyRollback(rollbackSql);
      console.log('\n✅ Rollback applied successfully.');
    } finally {
      await this.prisma.$disconnect();
    }
  }

  /**
   * Resolve the target migration name (latest if not specified).
   */
  private resolveMigration(name?: string): string | null {
    if (!fs.existsSync(this.migrationsDir)) return null;

    const migrations = fs
      .readdirSync(this.migrationsDir)
      .filter(f => {
        const full = path.join(this.migrationsDir, f);
        return fs.statSync(full).isDirectory() && f !== 'migration_lock.toml';
      })
      .sort();

    if (migrations.length === 0) return null;

    if (name) {
      if (!migrations.includes(name)) {
        console.error(`❌ Migration not found: ${name}`);
        console.error(`   Available: ${migrations.slice(-5).join(', ')}`);
        process.exit(1);
      }
      return name;
    }

    return migrations[migrations.length - 1];
  }

  /**
   * Ensure rollback.sql exists for the target migration, generating it if missing.
   */
  private async ensureRollbackSql(migrationName: string): Promise<string> {
    const migrationPath = path.join(this.migrationsDir, migrationName);
    const rollbackPath = path.join(migrationPath, 'rollback.sql');

    if (!fs.existsSync(rollbackPath)) {
      console.log('⚙️  rollback.sql not found — generating it now...');
      const generator = new RollbackGenerator();
      generator.generateRollback(migrationName);

      if (!fs.existsSync(rollbackPath)) {
        console.error('❌ Failed to generate rollback.sql');
        process.exit(1);
      }
    }

    return rollbackPath;
  }

  /**
   * Extract table names that will be dropped by the rollback SQL.
   */
  private extractDroppedTables(sql: string): string[] {
    const dropped = new Set<string>();
    const pattern = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(sql)) !== null) {
      dropped.add(m[1]);
    }
    return Array.from(dropped);
  }

  /**
   * Check which FK references would break if the given tables are dropped.
   * Returns violations grouped by (referencingTable, referencedTable).
   */
  private async checkForeignKeyViolations(droppedTables: string[]): Promise<FKViolation[]> {
    if (droppedTables.length === 0) return [];

    // Get all user tables
    const tables = await this.prisma.$queryRawUnsafe<TableRow[]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%'`
    );

    const violations: FKViolation[] = [];

    for (const { name: tableName } of tables) {
      // Get FK list for this table
      const fks = await this.prisma.$queryRawUnsafe<FKRow[]>(
        `PRAGMA foreign_key_list("${tableName}")`
      );

      for (const fk of fks) {
        if (!droppedTables.includes(fk.table)) continue;

        // Count rows in this table that reference the to-be-dropped table
        const countResult = await this.prisma.$queryRawUnsafe<CountRow[]>(
          `SELECT COUNT(*) AS count FROM "${tableName}" WHERE "${fk.from}" IS NOT NULL`
        );
        const affectedRowCount = Number(countResult[0]?.count ?? 0);

        violations.push({
          referencingTable: tableName,
          referencingColumn: fk.from,
          referencedTable: fk.table,
          referencedColumn: fk.to ?? 'id',
          affectedRowCount,
        });
      }
    }

    return violations;
  }

  /**
   * Check for FK violations already present in the database (pre-rollback state).
   */
  private async checkExistingFKViolations(): Promise<string[]> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `PRAGMA foreign_key_check`
      );
      return rows.map(r => `${r['table']}(rowid=${r['rowid']}): FK → ${r['parent']}`);
    } catch {
      return [];
    }
  }

  /**
   * Print the FK integrity report.
   */
  private printIntegrityReport(
    violations: FKViolation[],
    existingViolations: string[],
    droppedTables: string[]
  ): void {
    console.log('\n' + '='.repeat(60));
    console.log('  Foreign Key Integrity Report');
    console.log('='.repeat(60));

    if (existingViolations.length > 0) {
      console.log(`\n⚠️  Pre-existing FK violations in database (${existingViolations.length}):`);
      existingViolations.forEach(v => console.log(`   • ${v}`));
    } else {
      console.log('\n✅ No pre-existing FK violations in current database state.');
    }

    if (droppedTables.length === 0) {
      console.log('\n✅ No DROP TABLE statements in rollback — no FK impact analysis needed.');
      console.log('='.repeat(60) + '\n');
      return;
    }

    const blocking = violations.filter(v => v.affectedRowCount > 0);
    const safe = violations.filter(v => v.affectedRowCount === 0);

    if (safe.length > 0) {
      console.log(`\n✅ Safe FK references (0 referencing rows, no impact):`);
      safe.forEach(v =>
        console.log(
          `   • ${v.referencingTable}.${v.referencingColumn} → ${v.referencedTable}.${v.referencedColumn}`
        )
      );
    }

    if (blocking.length > 0) {
      console.log(`\n❌ FK violations that WILL occur after rollback (${blocking.length}):`);
      blocking.forEach(v =>
        console.log(
          `   • ${v.referencingTable}.${v.referencingColumn} → ${v.referencedTable}.${v.referencedColumn}` +
            ` (${v.affectedRowCount} referencing row${v.affectedRowCount !== 1 ? 's' : ''})`
        )
      );
      console.log('\n   ⚠️  These rows will have dangling foreign key references after the rollback.');
      console.log('   ⚠️  Consider cleaning up referencing rows before rolling back,');
      console.log('       or use --force to apply anyway (NOT recommended for production).');
    } else if (violations.length > 0) {
      console.log('\n✅ All FK references are safe — no rows would be orphaned.');
    }

    console.log('='.repeat(60) + '\n');
  }

  /**
   * Apply rollback SQL statements one by one.
   */
  private async applyRollback(sql: string): Promise<void> {
    console.log('\n🚀 Applying rollback SQL...');

    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    let applied = 0;
    for (const stmt of statements) {
      // Skip pure-comment blocks
      const nonComment = stmt
        .split('\n')
        .filter(l => !l.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (!nonComment) continue;

      try {
        await this.prisma.$executeRawUnsafe(nonComment);
        applied++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n❌ Failed to execute statement:\n   ${nonComment}\n   Error: ${msg}`);
        throw err;
      }
    }

    console.log(`   Applied ${applied} statement${applied !== 1 ? 's' : ''}.`);
  }

  /**
   * Prompt the user for a yes/no confirmation.
   */
  private confirm(prompt: string): Promise<boolean> {
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, answer => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const migrationName = args.find(a => !a.startsWith('--'));

  const verifier = new RollbackVerifier();
  verifier.run(migrationName, force, dryRun).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export default RollbackVerifier;
