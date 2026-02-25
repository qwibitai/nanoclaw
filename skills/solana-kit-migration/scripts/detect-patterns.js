#!/usr/bin/env node

/**
 * Solana Kit Migration Pattern Detector
 *
 * Scans TypeScript/JavaScript files for @solana/web3.js v1 patterns
 * and provides migration suggestions.
 *
 * Usage: node detect-patterns.js <directory> [--json] [--verbose]
 */

const fs = require('fs');
const path = require('path');

// Migration patterns with their Kit equivalents
const MIGRATION_PATTERNS = [
  {
    name: 'Connection',
    pattern: /new\s+Connection\s*\(/g,
    v1: 'new Connection(url, commitment)',
    kit: 'createSolanaRpc(url)',
    severity: 'high',
    notes: 'Split into createSolanaRpc() and createSolanaRpcSubscriptions()'
  },
  {
    name: 'Keypair.generate',
    pattern: /Keypair\.generate\s*\(/g,
    v1: 'Keypair.generate()',
    kit: 'await generateKeyPairSigner()',
    severity: 'high',
    notes: 'Now async, uses WebCrypto'
  },
  {
    name: 'Keypair.fromSecretKey',
    pattern: /Keypair\.fromSecretKey\s*\(/g,
    v1: 'Keypair.fromSecretKey(secretKey)',
    kit: 'await createKeyPairSignerFromBytes(secretKey)',
    severity: 'high',
    notes: 'Now async'
  },
  {
    name: 'PublicKey constructor',
    pattern: /new\s+PublicKey\s*\(/g,
    v1: 'new PublicKey(addressString)',
    kit: 'address(addressString)',
    severity: 'medium',
    notes: 'Address is now a string type, not a class'
  },
  {
    name: 'Transaction constructor',
    pattern: /new\s+Transaction\s*\(/g,
    v1: 'new Transaction()',
    kit: 'createTransactionMessage({ version: 0 })',
    severity: 'high',
    notes: 'Use pipe() for functional composition'
  },
  {
    name: 'VersionedTransaction',
    pattern: /new\s+VersionedTransaction\s*\(/g,
    v1: 'new VersionedTransaction(message)',
    kit: 'compileTransaction(transactionMessage)',
    severity: 'high',
    notes: 'Transactions are versioned by default in Kit'
  },
  {
    name: 'Transaction.add',
    pattern: /\.add\s*\(\s*(SystemProgram|Token)/g,
    v1: 'transaction.add(instruction)',
    kit: 'appendTransactionMessageInstruction(instruction, tx)',
    severity: 'medium',
    notes: 'Use appendTransactionMessageInstructions for multiple'
  },
  {
    name: 'SystemProgram.transfer',
    pattern: /SystemProgram\.transfer\s*\(/g,
    v1: 'SystemProgram.transfer({...})',
    kit: 'getTransferSolInstruction({...})',
    severity: 'medium',
    notes: 'Import from @solana-program/system'
  },
  {
    name: 'SystemProgram.createAccount',
    pattern: /SystemProgram\.createAccount\s*\(/g,
    v1: 'SystemProgram.createAccount({...})',
    kit: 'getCreateAccountInstruction({...})',
    severity: 'medium',
    notes: 'Import from @solana-program/system'
  },
  {
    name: 'sendAndConfirmTransaction',
    pattern: /sendAndConfirmTransaction\s*\(/g,
    v1: 'sendAndConfirmTransaction(connection, tx, signers)',
    kit: 'sendAndConfirmTransactionFactory({rpc, rpcSubscriptions})(signedTx)',
    severity: 'high',
    notes: 'Use factory pattern, sign separately'
  },
  {
    name: 'connection.sendTransaction',
    pattern: /connection\.sendTransaction\s*\(/g,
    v1: 'connection.sendTransaction(tx, signers)',
    kit: 'rpc.sendTransaction(wireTransaction).send()',
    severity: 'high',
    notes: 'Sign transaction first, then send wire format'
  },
  {
    name: 'connection.getBalance',
    pattern: /connection\.getBalance\s*\(/g,
    v1: 'await connection.getBalance(pubkey)',
    kit: 'await rpc.getBalance(address).send()',
    severity: 'low',
    notes: 'Add .send() suffix'
  },
  {
    name: 'connection.getAccountInfo',
    pattern: /connection\.getAccountInfo\s*\(/g,
    v1: 'await connection.getAccountInfo(pubkey)',
    kit: 'await rpc.getAccountInfo(address, { encoding: "base64" }).send()',
    severity: 'low',
    notes: 'Add encoding option and .send() suffix'
  },
  {
    name: 'connection.onAccountChange',
    pattern: /connection\.onAccountChange\s*\(/g,
    v1: 'connection.onAccountChange(pubkey, callback)',
    kit: 'rpcSubscriptions.accountNotifications(address).subscribe({...})',
    severity: 'high',
    notes: 'Use AsyncIterator pattern with AbortController'
  },
  {
    name: 'LAMPORTS_PER_SOL',
    pattern: /LAMPORTS_PER_SOL/g,
    v1: 'LAMPORTS_PER_SOL',
    kit: 'lamports(amount) or BigInt',
    severity: 'low',
    notes: 'Kit uses BigInt for all amounts'
  },
  {
    name: 'PublicKey.findProgramAddressSync',
    pattern: /PublicKey\.findProgramAddressSync\s*\(/g,
    v1: 'PublicKey.findProgramAddressSync(seeds, programId)',
    kit: 'await getProgramDerivedAddress({ programAddress, seeds })',
    severity: 'medium',
    notes: 'Import from @solana/addresses'
  },
  {
    name: '@solana/spl-token import',
    pattern: /from\s+['"]@solana\/spl-token['"]/g,
    v1: "import { ... } from '@solana/spl-token'",
    kit: "import { ... } from '@solana-program/token'",
    severity: 'medium',
    notes: 'Use @solana-program/token for Kit'
  },
  {
    name: 'toBase58',
    pattern: /\.toBase58\s*\(\)/g,
    v1: 'publicKey.toBase58()',
    kit: 'address (already a string)',
    severity: 'low',
    notes: 'Addresses are strings in Kit'
  },
  {
    name: 'toBuffer',
    pattern: /\.toBuffer\s*\(\)/g,
    v1: 'publicKey.toBuffer()',
    kit: 'getAddressEncoder().encode(address)',
    severity: 'medium',
    notes: 'Use codecs for encoding'
  }
];

// File extensions to scan
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];

// Directories to skip
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const findings = [];
  const lines = content.split('\n');

  for (const patternDef of MIGRATION_PATTERNS) {
    let match;
    const regex = new RegExp(patternDef.pattern.source, 'g');

    while ((match = regex.exec(content)) !== null) {
      // Find line number
      let lineNum = 1;
      let pos = 0;
      for (const line of lines) {
        if (pos + line.length >= match.index) {
          break;
        }
        pos += line.length + 1;
        lineNum++;
      }

      findings.push({
        pattern: patternDef.name,
        file: filePath,
        line: lineNum,
        match: match[0],
        v1: patternDef.v1,
        kit: patternDef.kit,
        severity: patternDef.severity,
        notes: patternDef.notes
      });
    }
  }

  return findings;
}

function walkDirectory(dir, findings = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.includes(entry.name)) {
        walkDirectory(fullPath, findings);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (EXTENSIONS.includes(ext)) {
        findings.push(...scanFile(fullPath));
      }
    }
  }

  return findings;
}

function summarizeFindings(findings) {
  const summary = {
    total: findings.length,
    byPattern: {},
    bySeverity: { high: 0, medium: 0, low: 0 },
    byFile: {}
  };

  for (const finding of findings) {
    // By pattern
    summary.byPattern[finding.pattern] = (summary.byPattern[finding.pattern] || 0) + 1;

    // By severity
    summary.bySeverity[finding.severity]++;

    // By file
    summary.byFile[finding.file] = (summary.byFile[finding.file] || 0) + 1;
  }

  return summary;
}

function printReport(findings, verbose = false) {
  const summary = summarizeFindings(findings);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║           SOLANA KIT MIGRATION PATTERN ANALYSIS              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`Total patterns found: ${summary.total}\n`);

  console.log('By Severity:');
  console.log(`  🔴 High:   ${summary.bySeverity.high}`);
  console.log(`  🟡 Medium: ${summary.bySeverity.medium}`);
  console.log(`  🟢 Low:    ${summary.bySeverity.low}`);
  console.log();

  console.log('By Pattern:');
  const sortedPatterns = Object.entries(summary.byPattern)
    .sort((a, b) => b[1] - a[1]);

  for (const [pattern, count] of sortedPatterns) {
    console.log(`  ${pattern}: ${count}`);
  }
  console.log();

  console.log('Top Files:');
  const sortedFiles = Object.entries(summary.byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [file, count] of sortedFiles) {
    console.log(`  ${file}: ${count}`);
  }
  console.log();

  if (verbose) {
    console.log('Detailed Findings:');
    console.log('─'.repeat(70));

    for (const finding of findings) {
      console.log(`\n[${finding.severity.toUpperCase()}] ${finding.pattern}`);
      console.log(`  File: ${finding.file}:${finding.line}`);
      console.log(`  v1:   ${finding.v1}`);
      console.log(`  Kit:  ${finding.kit}`);
      console.log(`  Note: ${finding.notes}`);
    }
  }

  // Recommendations
  console.log('\n' + '═'.repeat(70));
  console.log('RECOMMENDATIONS:');
  console.log('═'.repeat(70) + '\n');

  if (summary.total === 0) {
    console.log('✅ No v1 patterns detected. Already using Kit or no Solana code found.');
  } else if (summary.bySeverity.high > 50) {
    console.log('⚠️  HIGH migration complexity detected.');
    console.log('   Consider:');
    console.log('   1. Gradual migration using @solana/compat');
    console.log('   2. Prioritize high-traffic code paths');
    console.log('   3. Create abstraction layer for easier transition');
  } else if (summary.total < 30) {
    console.log('✅ LOW migration complexity. Full migration recommended.');
    console.log('   Estimated effort: Small to Medium');
  } else {
    console.log('🟡 MEDIUM migration complexity.');
    console.log('   Consider using @solana/compat for gradual migration.');
  }

  console.log();
}

// Main execution
const args = process.argv.slice(2);
const targetDir = args.find(a => !a.startsWith('--')) || '.';
const jsonOutput = args.includes('--json');
const verbose = args.includes('--verbose');

if (!fs.existsSync(targetDir)) {
  console.error(`Error: Directory not found: ${targetDir}`);
  process.exit(1);
}

const findings = walkDirectory(path.resolve(targetDir));

if (jsonOutput) {
  console.log(JSON.stringify({
    findings,
    summary: summarizeFindings(findings)
  }, null, 2));
} else {
  printReport(findings, verbose);
}
