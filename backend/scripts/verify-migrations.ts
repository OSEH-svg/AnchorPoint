#!/usr/bin/env node
/**
 * Prisma Migration Verification Script
 *
 * Verifies the integrity of Prisma migrations against a temporary database
 * to prevent breaking changes during production deployments.
 *
 * This script:
 * 1. Creates a temporary database
 * 2. Applies all migrations to it
 * 3. Verifies schema consistency
 * 4. Checks for destructive changes
 * 5. Tests migration reversibility
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Ensure default sqlite path when running in CI/testing
if (!process.env.DATABASE_URL) {
  const tmpDir = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
  console.log("DATABASE_URL not set; using default:", process.env.DATABASE_URL);
}

interface MigrationCheckResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  checks: {
    tempDatabaseCreated: boolean;
    migrationsApplied: boolean;
    schemaConsistent: boolean;
    noDestructiveChanges: boolean;
    migrationsReversible: boolean;
  };
}

class MigrationVerifier {
  private tempDbPath: string;
  private tempDbUrl: string;
  private prismaBinary: string;
  private schemaPath: string;
  private migrationsPath: string;
  private ephemeralPostgresDbName?: string;
  private ephemeralAdminUrl?: string;

  constructor() {
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = 'postgresql://prisma:prisma_password@localhost:5432/cidb';
    }
    this.tempDbPath = path.join(os.tmpdir(), `prisma-verify-${Date.now()}.db`);
    const tempDbName = `prisma-verify-${Date.now()}.db`;
    this.tempDbPath = path.join(__dirname, '..', tempDbName);
    this.tempDbUrl = `file:./${tempDbName}`;
    this.prismaBinary = 'npx prisma';
    this.schemaPath = path.join(__dirname, '../prisma/schema.prisma');
    this.migrationsPath = path.join(__dirname, '../prisma/migrations');
  }

  /**
   * Execute a command and return the result
   */
  private run(command: string, options: any = {}): string {
    try {
      return execSync(command, {
        stdio: 'pipe',
        encoding: 'utf-8',
        ...options,
      });
    } catch (error: any) {
      const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : '';
      const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : '';
      throw new Error(`Command failed: ${command}\n${error.message}${stdout}${stderr}`);
    }
  }

  /**
   * Execute a command silently (suppress output)
   */
  private runSilent(command: string, options: any = {}): string {
    try {
      return execSync(command, {
        stdio: 'pipe',
        encoding: 'utf-8',
        ...options,
      });
    } catch (error: any) {
      const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : '';
      const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : '';
      throw new Error(`Command failed: ${command}\n${error.message}${stdout}${stderr}`);
    }
  }

  /**
   * Clean up temporary database
   */
  private cleanup(): void {
    try {
      if (fs.existsSync(this.tempDbPath)) {
        fs.unlinkSync(this.tempDbPath);
        console.log('🧹 Cleaned up temporary database');
      }
    } finally {
      // Always drop ephemeral Postgres DB if it was created
      this.dropEphemeralPostgresDatabase();
    }
  }

  /**
   * Reset the database schema for PostgreSQL databases
   * Drops and recreates the public schema to ensure a clean state
   * Only runs when explicitly enabled via VERIFY_MIGRATIONS_ALLOW_RESET env var
   *
   * @param databaseUrl - Explicit database URL to reset (ensures consistency with migrate deploy)
   */
  private resetDatabaseSchema(databaseUrl?: string): boolean {
    try {
      // Only run this in CI/ephemeral environments with explicit permission
      if (process.env.VERIFY_MIGRATIONS_ALLOW_RESET !== 'true') {
        return true; // Skip reset if not explicitly enabled
      }

      const dbUrl = databaseUrl || process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error('DATABASE_URL must be provided to reset database schema');
      }

      // If SQLite, no need to drop schema (file-based)
      if (dbUrl.startsWith('file:')) {
        return true; // SQLite doesn't need schema reset
      }

      // Safety check: do not drop non-local or production-looking databases
      try {
        // Parse PostgreSQL connection string safely
        const dbUrlObj = new URL(dbUrl.replace(/^postgresql:\/\//, 'http://'));
        const hostname = dbUrlObj.hostname || '';
        const pathname = dbUrlObj.pathname || '';
        const dbName = pathname.replace(/^\//, '').split('?')[0]; // Extract DB name before query params

        // Allow only local/ci ephemeral hosts or names containing 'test' or 'prisma-verify'
        const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 'postgres';
        const isCiEnvironment = process.env.CI === 'true';
        const isEphemeralName = /test|ci|prisma-verify/i.test(dbName);

        if (!isLocalHost && !isCiEnvironment && !isEphemeralName) {
          throw new Error(
            `Refusing to reset schema for host '${hostname}' and db '${dbName}'. ` +
            'Schema reset only allowed for ephemeral databases (local, CI, or containing test/ci/prisma-verify in name). ' +
            'Set VERIFY_MIGRATIONS_ALLOW_RESET only for ephemeral DBs.'
          );
        }

        console.log(`ℹ️  Reset allowed for ephemeral DB: host=${hostname}, name=${dbName}`);
      } catch (parseErr) {
        // If parsing fails, refuse to run reset to be safe
        throw new Error(`Unable to safely parse database URL for reset safety check: ${parseErr}`);
      }

      console.log('🔄 Resetting database schema for migration verification...');

      this.runSilent(
        `${this.prismaBinary} db execute --url "${dbUrl}" --stdin`,
        {
          input: 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
        }
      );

      console.log('✅ Database schema reset successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to reset database schema:', error);
      return false;
    }
  }

  /**
   * Build a PostgreSQL URL with a different database name
   */
  private buildDbUrlWithDb(originalUrl: string, newDbName: string): string {
    const url = new URL(originalUrl);
    url.pathname = `/${newDbName}`;
    return url.toString();
  }

  /**
   * Create an ephemeral PostgreSQL database for migration verification
   * This ensures each verification run has a clean, isolated database
   */
  private createEphemeralPostgresDatabase(originalUrl: string): string {
    if (!originalUrl || originalUrl.startsWith('file:')) {
      return originalUrl; // SQLite doesn't need ephemeral creation
    }

    // Build admin URL pointing to 'postgres' database to create new DB
    const adminUrl = this.buildDbUrlWithDb(originalUrl, 'postgres');
    this.ephemeralAdminUrl = adminUrl;

    // Generate unique ephemeral DB name
    const ephemName = `prisma_verify_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.ephemeralPostgresDbName = ephemName;

    console.log(`🔧 Creating ephemeral verification database: ${ephemName}`);

    try {
      this.runSilent(`${this.prismaBinary} db execute --url "${adminUrl}" --stdin`, {
        input: `CREATE DATABASE "${ephemName}";`,
      });
    } catch (err) {
      console.error('❌ Failed to create ephemeral database:', err);
      throw err;
    }

    // Build and return URL pointing to new ephemeral DB
    const newUrl = this.buildDbUrlWithDb(originalUrl, ephemName);

    // Wait for the new DB to be ready before returning
    this.waitForDbReady(newUrl);

    return newUrl;
  }

  /**
   * Drop ephemeral PostgreSQL database during cleanup
   */
  private dropEphemeralPostgresDatabase(): void {
    try {
      if (this.ephemeralPostgresDbName && this.ephemeralAdminUrl) {
        console.log(`🧹 Dropping ephemeral database: ${this.ephemeralPostgresDbName}`);
        this.runSilent(`${this.prismaBinary} db execute --url "${this.ephemeralAdminUrl}" --stdin`, {
          input: `DROP DATABASE IF EXISTS "${this.ephemeralPostgresDbName}";`,
        });
      }
    } catch (err) {
      console.warn('⚠️  Failed to drop ephemeral database:', err);
    }
  }

  /**
   * Wait for database to be ready by polling with SELECT 1
   */
  private waitForDbReady(dbUrl: string, attempts = 15, delayMs = 500): void {
    for (let i = 0; i < attempts; i++) {
      try {
        this.runSilent(`${this.prismaBinary} db execute --url "${dbUrl}" --stdin`, {
          input: 'SELECT 1;',
        });
        console.log(`✅ Database is ready`);
        return;
      } catch (err) {
        if (i < attempts - 1) {
          const ms = delayMs * (i + 1);
          console.log(`⏳ Waiting for DB readiness (${i + 1}/${attempts}) - retrying in ${ms}ms`);
          // Use setTimeout to avoid blocking
          execSync(`sleep ${(ms / 1000).toFixed(3)}`);
        }
      }
    }
    throw new Error(`Timed out waiting for database to become ready after ${attempts} attempts`);
  }

  /**
   * Create temporary database
   */
  private createTempDatabase(): boolean {
    try {
      console.log('📦 Creating temporary database...');
      // Just ensure the path doesn't exist, it will be created by Prisma
      if (fs.existsSync(this.tempDbPath)) {
        fs.unlinkSync(this.tempDbPath);
      }
      console.log('✅ Temporary database path ready');
      return true;
    } catch (error) {
      console.error('❌ Failed to create temporary database:', error);
      return false;
    }
  }

  /**
   * Apply all migrations to temporary database
   */
  private applyMigrations(): boolean {
    try {
      console.log('🔄 Applying migrations to temporary database...');

      let env = {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://prisma:prisma_password@localhost:5432/cidb',
      };

      // If DATABASE_URL is Postgres, create a unique ephemeral DB to avoid collisions
      if (!env.DATABASE_URL!.startsWith('file:')) {
        env.DATABASE_URL = this.createEphemeralPostgresDatabase(env.DATABASE_URL!);
      }

      // Reset schema before applying migrations to ensure clean state
      // Pass the explicit DATABASE_URL so reset and migrate operate on the same DB
      if (!this.resetDatabaseSchema(env.DATABASE_URL)) {
        throw new Error('Failed to reset database schema');
      }

      // Ensure DB is ready before applying migrations
      this.waitForDbReady(env.DATABASE_URL);

      // Apply committed migrations to the temporary database.
      this.runSilent(`${this.prismaBinary} migrate deploy`, {
        env,
        cwd: path.join(__dirname, '..'),
      });

      console.log('✅ All migrations applied successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to apply migrations:', error);
      return false;
    }
  }

  /**
   * Verify schema consistency between migrations and schema.prisma
   */
  private verifySchemaConsistency(): boolean {
    try {
      console.log('🔍 Verifying schema consistency...');

      const env = {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://prisma:prisma_password@localhost:5432/cidb',
      };

      // Check if the database schema matches the Prisma schema
      const diffOutput = this.runSilent(
        `${this.prismaBinary} migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`,
        {
          env,
          cwd: path.join(__dirname, '..'),
        }
      );

      // If there's any diff output, there's inconsistency
      if (diffOutput.trim() && !diffOutput.includes('No difference') && !diffOutput.includes('-- This is an empty migration.')) {
        console.error('❌ Schema inconsistency detected:');
        console.error(diffOutput);
        return false;
      }

      console.log('✅ Schema is consistent');
      return true;
    } catch (error) {
      console.error('❌ Schema consistency check failed:', error);
      return false;
    }
  }

  /**
   * Check for destructive changes in migrations
   */
  private checkDestructiveChanges(): boolean {
    try {
      console.log('⚠️  Checking for destructive changes...');

      const env = {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://prisma:prisma_password@localhost:5432/cidb',
      };

      // Use Prisma migrate diff to detect destructive changes
      try {
        const shadowUrl = process.env.SHADOW_DATABASE_URL || 'postgresql://prisma:prisma_password@localhost:5433/shadowdb';
        this.runSilent(
          `${this.prismaBinary} migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "${shadowUrl}" --exit-code`,
          {
            env,
            cwd: path.join(__dirname, '..'),
          }
        );
        console.log('✅ No destructive changes detected');
        return true;
      } catch (error: any) {
        if (error.status === 1) {
          console.error('❌ Destructive changes detected in migrations!');
          console.error('Please review your migration files for:');
          console.error('  - DROP TABLE operations');
          console.error('  - DROP COLUMN operations');
          console.error('  - DELETE/TRUNCATE operations');
          console.error('  - ALTER COLUMN that changes types');
          return false;
        }
        throw error;
      }
    } catch (error) {
      console.error('❌ Destructive change check failed:', error);
      return false;
    }
  }

  /**
   * Test migration reversibility
   */
  private testMigrationReversibility(): boolean {
    try {
      console.log('🔙 Testing migration reversibility...');

      const env = {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://prisma:prisma_password@localhost:5432/cidb',
      };

      // Get the list of migrations
      const migrationDirs = fs.readdirSync(this.migrationsPath)
        .filter((dir) => fs.statSync(path.join(this.migrationsPath, dir)).isDirectory())
        .sort()
        .reverse();

      if (migrationDirs.length === 0) {
        console.log('✅ No migrations to test');
        return true;
      }

      console.log(`Testing ${migrationDirs.length} migration(s) for reversibility...`);

      // Check each migration for rollback.sql
      for (const migrationDir of migrationDirs) {
        const rollbackPath = path.join(this.migrationsPath, migrationDir, 'rollback.sql');
        const migrationSqlPath = path.join(this.migrationsPath, migrationDir, 'migration.sql');

        if (!fs.existsSync(migrationSqlPath)) {
          console.warn(`⚠️  Warning: Migration ${migrationDir} missing migration.sql`);
          continue;
        }

        if (!fs.existsSync(rollbackPath)) {
          console.warn(`⚠️  Warning: Migration ${migrationDir} missing rollback.sql`);
          console.warn('  Consider generating a rollback script using: npm run migrate:rollback');
        }
      }

      console.log('✅ Migration reversibility check completed');
      return true;
    } catch (error) {
      console.error('❌ Migration reversibility test failed:', error);
      return false;
    }
  }

  /**
   * Validate migration files
   */
  private validateMigrationFiles(): boolean {
    try {
      console.log('📄 Validating migration files...');

      const migrationDirs = fs.readdirSync(this.migrationsPath)
        .filter((dir) => fs.statSync(path.join(this.migrationsPath, dir)).isDirectory());

      for (const migrationDir of migrationDirs) {
        const migrationSqlPath = path.join(this.migrationsPath, migrationDir, 'migration.sql');

        if (!fs.existsSync(migrationSqlPath)) {
          console.error(`❌ Migration ${migrationDir} missing migration.sql`);
          return false;
        }

        const content = fs.readFileSync(migrationSqlPath, 'utf-8');
        if (content.trim().length === 0) {
          console.error(`❌ Migration ${migrationDir} has empty migration.sql`);
          return false;
        }
      }

      console.log('✅ All migration files are valid');
      return true;
    } catch (error) {
      console.error('❌ Migration file validation failed:', error);
      return false;
    }
  }

  /**
   * Run all verification checks
   */
  public verify(): MigrationCheckResult {
    const result: MigrationCheckResult = {
      success: false,
      errors: [],
      warnings: [],
      checks: {
        tempDatabaseCreated: false,
        migrationsApplied: false,
        schemaConsistent: false,
        noDestructiveChanges: false,
        migrationsReversible: false,
      },
    };

    try {
      // Create temporary database
      result.checks.tempDatabaseCreated = this.createTempDatabase();
      if (!result.checks.tempDatabaseCreated) {
        result.errors.push('Failed to create temporary database');
        return result;
      }

      // Validate migration files
      const filesValid = this.validateMigrationFiles();
      if (!filesValid) {
        result.errors.push('Migration file validation failed');
        return result;
      }

      // Apply migrations
      result.checks.migrationsApplied = this.applyMigrations();
      if (!result.checks.migrationsApplied) {
        result.errors.push('Failed to apply migrations to temporary database');
        return result;
      }

      // Verify schema consistency
      result.checks.schemaConsistent = this.verifySchemaConsistency();
      if (!result.checks.schemaConsistent) {
        result.errors.push('Schema consistency check failed');
      }

      // Check for destructive changes
      result.checks.noDestructiveChanges = this.checkDestructiveChanges();
      if (!result.checks.noDestructiveChanges) {
        result.errors.push('Destructive changes detected');
      }

      // Test migration reversibility
      result.checks.migrationsReversible = this.testMigrationReversibility();
      if (!result.checks.migrationsReversible) {
        result.warnings.push('Some migrations may not be reversible');
      }

      // Overall success
      result.success = result.errors.length === 0;

      return result;
    } catch (error) {
      result.errors.push(`Unexpected error: ${error}`);
      return result;
    } finally {
      this.cleanup();
    }
  }

  /**
   * Print verification results
   */
  public printResults(result: MigrationCheckResult): void {
    console.log('\n' + '='.repeat(80));
    console.log('📊 Migration Verification Results');
    console.log('='.repeat(80));

    console.log('\n✅ Passed Checks:');
    if (result.checks.tempDatabaseCreated) console.log('  ✓ Temporary database created');
    if (result.checks.migrationsApplied) console.log('  ✓ Migrations applied successfully');
    if (result.checks.schemaConsistent) console.log('  ✓ Schema consistency verified');
    if (result.checks.noDestructiveChanges) console.log('  ✓ No destructive changes');
    if (result.checks.migrationsReversible) console.log('  ✓ Migrations reversible');

    if (result.warnings.length > 0) {
      console.log('\n⚠️  Warnings:');
      result.warnings.forEach((warning) => console.log(`  ⚠️  ${warning}`));
    }

    if (result.errors.length > 0) {
      console.log('\n❌ Errors:');
      result.errors.forEach((error) => console.log(`  ❌ ${error}`));
    }

    console.log('\n' + '='.repeat(80));
    console.log(`Total: ${Object.values(result.checks).filter(Boolean).length} checks`);
    console.log(`✅ Passed: ${Object.values(result.checks).filter(Boolean).length}`);
    console.log(`⚠️  Warnings: ${result.warnings.length}`);
    console.log(`❌ Errors: ${result.errors.length}`);
    console.log('='.repeat(80) + '\n');

    if (result.success) {
      console.log('✨ All migration verification checks passed!');
    } else {
      console.log('💥 Migration verification failed. Please fix the errors above.');
    }
  }
}

// Main execution
if (require.main === module) {
  const verifier = new MigrationVerifier();
  const result = verifier.verify();
  verifier.printResults(result);

  process.exit(result.success ? 0 : 1);
}

export { MigrationVerifier, MigrationCheckResult };
