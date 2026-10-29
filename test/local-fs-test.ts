import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_ROOT = "/tmp/agent-bridge-local-fs-test";
const WORKSPACE_DIR = path.join(TEST_ROOT, "workspace");

async function runLocalFsTests() {
  console.log("=================================================");
  console.log("  agent-bridge-mcp local-fs Test Suite");
  console.log("=================================================");
  console.log(`Setting up test environment in: ${TEST_ROOT}\n`);

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const logsDir = path.join(TEST_ROOT, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  // Minimal agents.json for server init
  fs.writeFileSync(
    path.join(TEST_ROOT, "agents.json"),
    JSON.stringify({ codex: { command: "codex", args: ["exec"], input: "arg" } }, null, 2),
    "utf8"
  );

  // Setup test files in workspace
  const textFile1 = path.join(WORKSPACE_DIR, "greeting.txt");
  fs.writeFileSync(textFile1, "Hello world, testing local-fs tools!", "utf8");

  const textFile2 = path.join(WORKSPACE_DIR, "notes.md");
  fs.writeFileSync(textFile2, "# Notes\nLine 1\nLine 2\n", "utf8");

  const hiddenFile = path.join(WORKSPACE_DIR, ".env.local");
  fs.writeFileSync(hiddenFile, "FOO=bar\n", "utf8");

  const subDir = path.join(WORKSPACE_DIR, "docs");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "readme.txt"), "Documentation content", "utf8");

  const hiddenDir = path.join(WORKSPACE_DIR, ".config");
  fs.mkdirSync(hiddenDir, { recursive: true });

  // Large file (70KB) to test chunking and clamping
  const largeFile = path.join(WORKSPACE_DIR, "large.txt");
  const largeContent = "A".repeat(70000);
  fs.writeFileSync(largeFile, largeContent, "utf8");

  // Binary file with null bytes
  const binaryFile = path.join(WORKSPACE_DIR, "image.bin");
  const binBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d, 0x0a]);
  fs.writeFileSync(binaryFile, binBuf);

  // Fake sensitive file name in workspace to verify pattern blocking
  const fakePemFile = path.join(WORKSPACE_DIR, "test-cert.pem");
  fs.writeFileSync(fakePemFile, "FAKE_PEM_DATA", "utf8");

  // Connect client to dist/index.js
  const serverPath = path.resolve("dist/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      AGENT_BRIDGE_ROOT: TEST_ROOT,
    },
  });
  const client = new Client({ name: "local-fs-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // -------------------------------------------------
    // [Test 1] list_directory validations & directory listing
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 1] list_directory operations");
    console.log("-------------------------------------------------");

    // 1.1 Non-absolute path error
    const relList = await client.callTool({
      name: "list_directory",
      arguments: { path: "relative/path" },
    });
    assert.equal(relList.isError, true);
    assert.ok(
      ((relList.content as any)[0]?.text || "").includes("must be an absolute path"),
      "Should reject non-absolute path"
    );

    // 1.2 Non-existent directory error
    const nonExistList = await client.callTool({
      name: "list_directory",
      arguments: { path: path.join(WORKSPACE_DIR, "does-not-exist") },
    });
    assert.equal(nonExistList.isError, true);
    assert.ok(
      ((nonExistList.content as any)[0]?.text || "").includes("does not exist"),
      "Should reject non-existent path"
    );

    // 1.3 Not a directory error (passing file path)
    const fileAsDir = await client.callTool({
      name: "list_directory",
      arguments: { path: textFile1 },
    });
    assert.equal(fileAsDir.isError, true);
    assert.ok(
      ((fileAsDir.content as any)[0]?.text || "").includes("not a directory"),
      "Should reject file path when listing directory"
    );

    // 1.4 Valid directory list (show_hidden: false / omitted)
    const normalList = await client.callTool({
      name: "list_directory",
      arguments: { path: WORKSPACE_DIR },
    });
    assert.equal(normalList.isError, undefined);
    const normalData = JSON.parse((normalList.content as any)[0]?.text || "{}");
    assert.equal(normalData.directory, WORKSPACE_DIR);
    assert.equal(normalData.hasMore, false);

    const names = normalData.items.map((i: any) => i.name);
    // Hidden files should be omitted
    assert.ok(!names.includes(".env.local"), "Hidden file should be omitted by default");
    assert.ok(!names.includes(".config"), "Hidden directory should be omitted by default");
    // Visible items must be present
    assert.ok(names.includes("docs"), "Should include visible directory");
    assert.ok(names.includes("greeting.txt"), "Should include greeting.txt");
    assert.ok(names.includes("notes.md"), "Should include notes.md");

    // Check directory sorting: directories first
    const firstItem = normalData.items[0];
    assert.equal(firstItem.name, "docs");
    assert.equal(firstItem.type, "directory");

    // Check file item metadata
    const greetingItem = normalData.items.find((i: any) => i.name === "greeting.txt");
    assert.equal(greetingItem.type, "file");
    assert.equal(typeof greetingItem.sizeBytes, "number");
    assert.ok(greetingItem.sizeBytes > 0);
    assert.ok(typeof greetingItem.modifiedAt === "string");

    // 1.5 Valid directory list with show_hidden: true
    const hiddenList = await client.callTool({
      name: "list_directory",
      arguments: { path: WORKSPACE_DIR, show_hidden: true },
    });
    assert.equal(hiddenList.isError, undefined);
    const hiddenData = JSON.parse((hiddenList.content as any)[0]?.text || "{}");
    const hiddenNames = hiddenData.items.map((i: any) => i.name);
    assert.ok(hiddenNames.includes(".env.local"), "Hidden file should be included when show_hidden=true");
    assert.ok(hiddenNames.includes(".config"), "Hidden directory should be included when show_hidden=true");

    // 1.6 Credential directory protection
    const sshDir = path.join(os.homedir(), ".ssh");
    const sshList = await client.callTool({
      name: "list_directory",
      arguments: { path: sshDir },
    });
    assert.equal(sshList.isError, true, "Must block ~/.ssh directory listing");
    assert.ok(
      ((sshList.content as any)[0]?.text || "").includes("Access denied"),
      "Must state Access denied for ~/.ssh"
    );

    console.log("✓ Test 1 passed: list_directory behavior, sorting, hidden filter & credential blocking verified.\n");

    // -------------------------------------------------
    // [Test 2] read_file validations, chunking & binary protection
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 2] read_file operations");
    console.log("-------------------------------------------------");

    // 2.1 Non-absolute path error
    const relRead = await client.callTool({
      name: "read_file",
      arguments: { path: "relative/file.txt" },
    });
    assert.equal(relRead.isError, true);
    assert.ok(((relRead.content as any)[0]?.text || "").includes("must be an absolute path"));

    // 2.2 Non-existent file error
    const nonExistRead = await client.callTool({
      name: "read_file",
      arguments: { path: path.join(WORKSPACE_DIR, "missing.txt") },
    });
    assert.equal(nonExistRead.isError, true);
    assert.ok(((nonExistRead.content as any)[0]?.text || "").includes("does not exist"));

    // 2.3 Directory path passed to read_file error
    const dirRead = await client.callTool({
      name: "read_file",
      arguments: { path: WORKSPACE_DIR },
    });
    assert.equal(dirRead.isError, true);
    assert.ok(((dirRead.content as any)[0]?.text || "").includes("not a regular file"));

    // 2.4 Read whole small file
    const readFull = await client.callTool({
      name: "read_file",
      arguments: { path: textFile1 },
    });
    assert.equal(readFull.isError, undefined);
    const readFullData = JSON.parse((readFull.content as any)[0]?.text || "{}");
    assert.equal(readFullData.content, "Hello world, testing local-fs tools!");
    assert.equal(readFullData.offset, 0);
    assert.equal(readFullData.bytesRead, 36);
    assert.equal(readFullData.eof, true);

    // 2.5 Read slice with offset and length
    const readSlice = await client.callTool({
      name: "read_file",
      arguments: { path: textFile1, offset: 6, length: 5 },
    });
    assert.equal(readSlice.isError, undefined);
    const sliceData = JSON.parse((readSlice.content as any)[0]?.text || "{}");
    assert.equal(sliceData.content, "world");
    assert.equal(sliceData.offset, 6);
    assert.equal(sliceData.bytesRead, 5);
    assert.equal(sliceData.eof, false);

    // 2.6 Read large file with clamping and chunking
    const readLarge = await client.callTool({
      name: "read_file",
      arguments: { path: largeFile, offset: 0, length: 50000 },
    });
    assert.equal(readLarge.isError, undefined);
    const largeData = JSON.parse((readLarge.content as any)[0]?.text || "{}");
    assert.equal(largeData.bytesRead, 50000);
    assert.equal(largeData.totalBytes, 70000);
    assert.equal(largeData.eof, false);

    // 2.7 Read past EOF
    const readEof = await client.callTool({
      name: "read_file",
      arguments: { path: textFile1, offset: 9999 },
    });
    assert.equal(readEof.isError, undefined);
    const eofData = JSON.parse((readEof.content as any)[0]?.text || "{}");
    assert.equal(eofData.bytesRead, 0);
    assert.equal(eofData.eof, true);
    assert.equal(eofData.content, "");

    // 2.8 Binary file protection
    const readBin = await client.callTool({
      name: "read_file",
      arguments: { path: binaryFile },
    });
    assert.equal(readBin.isError, undefined);
    const binData = JSON.parse((readBin.content as any)[0]?.text || "{}");
    assert.equal(binData.isBinary, true, "Must flag isBinary: true");
    assert.equal(binData.content, undefined, "Must suppress binary content string");
    assert.ok(binData.message.includes("Binary file content suppressed"));

    // 2.9 Sensitive file blocked
    const pemRead = await client.callTool({
      name: "read_file",
      arguments: { path: fakePemFile },
    });
    assert.equal(pemRead.isError, true, "Must block .pem file");
    assert.ok(((pemRead.content as any)[0]?.text || "").includes("Access denied"));

    const shadowRead = await client.callTool({
      name: "read_file",
      arguments: { path: "/etc/shadow" },
    });
    assert.equal(shadowRead.isError, true, "Must block /etc/shadow");
    assert.ok(((shadowRead.content as any)[0]?.text || "").includes("Access denied"));

    const idRsaRead = await client.callTool({
      name: "read_file",
      arguments: { path: path.join(os.homedir(), ".ssh", "id_rsa") },
    });
    assert.equal(idRsaRead.isError, true, "Must block ~/.ssh/id_rsa");
    assert.ok(((idRsaRead.content as any)[0]?.text || "").includes("Access denied"));

    console.log("✓ Test 2 passed: read_file slice, eof, chunking, binary detection & credential blocking verified.\n");

    // -------------------------------------------------
    // [Test 3] get_file_info metadata & permissions
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 3] get_file_info operations");
    console.log("-------------------------------------------------");

    // 3.1 Non-absolute path error
    const relInfo = await client.callTool({
      name: "get_file_info",
      arguments: { path: "relative/notes.md" },
    });
    assert.equal(relInfo.isError, true);
    assert.ok(((relInfo.content as any)[0]?.text || "").includes("must be an absolute path"));

    // 3.2 Non-existent file error
    const missingInfo = await client.callTool({
      name: "get_file_info",
      arguments: { path: path.join(WORKSPACE_DIR, "missing.txt") },
    });
    assert.equal(missingInfo.isError, true);
    assert.ok(((missingInfo.content as any)[0]?.text || "").includes("does not exist"));

    // 3.3 File metadata
    const fileInfo = await client.callTool({
      name: "get_file_info",
      arguments: { path: textFile2 },
    });
    assert.equal(fileInfo.isError, undefined);
    const fileInfoData = JSON.parse((fileInfo.content as any)[0]?.text || "{}");
    assert.equal(fileInfoData.exists, true);
    assert.equal(fileInfoData.isFile, true);
    assert.equal(fileInfoData.isDirectory, false);
    assert.equal(fileInfoData.isSymbolicLink, false);
    assert.ok(typeof fileInfoData.sizeBytes === "number" && fileInfoData.sizeBytes > 0);
    assert.ok(typeof fileInfoData.permissions === "string" && fileInfoData.permissions.length > 0);
    assert.ok(typeof fileInfoData.modifiedAt === "string");

    // 3.4 Directory metadata
    const dirInfo = await client.callTool({
      name: "get_file_info",
      arguments: { path: subDir },
    });
    assert.equal(dirInfo.isError, undefined);
    const dirInfoData = JSON.parse((dirInfo.content as any)[0]?.text || "{}");
    assert.equal(dirInfoData.exists, true);
    assert.equal(dirInfoData.isFile, false);
    assert.equal(dirInfoData.isDirectory, true);

    // 3.5 Credential path blocked
    const blockedInfo = await client.callTool({
      name: "get_file_info",
      arguments: { path: path.join(os.homedir(), ".aws", "credentials") },
    });
    assert.equal(blockedInfo.isError, true);
    assert.ok(((blockedInfo.content as any)[0]?.text || "").includes("Access denied"));

    console.log("✓ Test 3 passed: get_file_info metadata, types, permissions & credential blocking verified.\n");

    // -------------------------------------------------
    // [Test 4] Audit log verification
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 4] Audit log verification");
    console.log("-------------------------------------------------");
    const auditPath = path.join(TEST_ROOT, "logs", "audit.log");
    assert.ok(fs.existsSync(auditPath), "audit.log must exist");
    const auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    assert.ok(auditLines.length >= 3, "Audit log must contain records for tool calls");

    const toolsLogged = auditLines.map((line) => {
      const rec = JSON.parse(line);
      assert.ok(rec.ts, "Audit record must contain timestamp");
      assert.equal(rec.content, undefined, "Audit record must NOT log file content");
      assert.equal(rec.output, undefined, "Audit record must NOT log tool output");
      return rec.tool;
    });

    assert.ok(toolsLogged.includes("list_directory"), "audit.log must record list_directory");
    assert.ok(toolsLogged.includes("read_file"), "audit.log must record read_file");
    assert.ok(toolsLogged.includes("get_file_info"), "audit.log must record get_file_info");

    console.log("✓ Test 4 passed: Audit log records verified (tool name and timestamp only, no leakage).\n");

    // -------------------------------------------------
    // [Test 5] list_directory with depth recursion & noise filtering
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 5] list_directory with depth recursion");
    console.log("-------------------------------------------------");
    // Create nested directory structure: workspace/src/components/Button.tsx
    const nestedDir = path.join(WORKSPACE_DIR, "src", "components");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "Button.tsx"), "export const Button = () => null;", "utf8");

    // Create a node_modules folder to verify noise filtering
    const nodeModulesDir = path.join(WORKSPACE_DIR, "node_modules", "dummy");
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, "index.js"), "module.exports = {};", "utf8");

    const depthList = await client.callTool({
      name: "list_directory",
      arguments: { path: WORKSPACE_DIR, depth: 3 },
    });
    assert.equal(depthList.isError, undefined);
    const depthData = JSON.parse((depthList.content as any)[0]?.text || "{}");
    assert.equal(depthData.depth, 3);
    const depthPaths = depthData.items.map((i: any) => i.path);

    // Assert nested items are discovered
    assert.ok(depthPaths.includes("src"), "Must include src dir");
    assert.ok(depthPaths.includes("src/components"), "Must include src/components dir");
    assert.ok(depthPaths.includes("src/components/Button.tsx"), "Must include nested Button.tsx");
    assert.ok(depthPaths.includes("docs/readme.txt"), "Must include docs/readme.txt");

    // Assert noise directory is filtered out
    assert.ok(!depthPaths.some((p: string) => p.includes("node_modules")), "node_modules must be filtered out");
    console.log("✓ Test 5 passed: list_directory depth recursion and noise filtering verified.\n");

    // -------------------------------------------------
    // [Test 6] read_multiple_files batch reading & per-file error handling
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 6] read_multiple_files batch execution");
    console.log("-------------------------------------------------");
    const batchResp = await client.callTool({
      name: "read_multiple_files",
      arguments: {
        paths: [
          textFile1,
          textFile2,
          path.join(WORKSPACE_DIR, "non-existent.txt"),
          fakePemFile, // blocked credential
        ],
      },
    });
    assert.equal(batchResp.isError, undefined);
    const batchData = JSON.parse((batchResp.content as any)[0]?.text || "{}");
    assert.equal(batchData.totalRequested, 4);
    assert.equal(batchData.totalSuccess, 2);

    const f1 = batchData.files.find((f: any) => f.path === textFile1);
    assert.ok(f1 && f1.success && f1.content.includes("Hello world"));

    const f2 = batchData.files.find((f: any) => f.path === textFile2);
    assert.ok(f2 && f2.success && f2.content.includes("# Notes"));

    const fMissing = batchData.files.find((f: any) => f.path.includes("non-existent.txt"));
    assert.ok(fMissing && !fMissing.success && fMissing.error.includes("File does not exist"));

    const fBlocked = batchData.files.find((f: any) => f.path === fakePemFile);
    assert.ok(fBlocked && !fBlocked.success && fBlocked.error.includes("Access denied"));

    console.log("✓ Test 6 passed: read_multiple_files batch reading and per-file fault isolation verified.\n");

    // -------------------------------------------------
    // [Test 7] write_file creation, parents & overwrite control
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 7] write_file execution");
    console.log("-------------------------------------------------");
    const newFilePath = path.join(WORKSPACE_DIR, "nested", "deep", "created.txt");
    const writeResp = await client.callTool({
      name: "write_file",
      arguments: {
        path: newFilePath,
        content: "console.log('created by write_file');\n",
        overwrite: true,
      },
    });
    assert.equal(writeResp.isError, undefined);
    assert.ok(fs.existsSync(newFilePath));
    assert.equal(fs.readFileSync(newFilePath, "utf8"), "console.log('created by write_file');\n");

    // Test overwrite: false failure
    const noOverwriteResp = await client.callTool({
      name: "write_file",
      arguments: {
        path: newFilePath,
        content: "new content",
        overwrite: false,
      },
    });
    assert.equal(noOverwriteResp.isError, true);
    assert.ok(((noOverwriteResp.content as any)[0]?.text || "").includes("already exists"));

    // Test credential block
    const blockedWrite = await client.callTool({
      name: "write_file",
      arguments: {
        path: path.join(os.homedir(), ".ssh", "authorized_keys"),
        content: "malicious",
      },
    });
    assert.equal(blockedWrite.isError, true);
    assert.ok(((blockedWrite.content as any)[0]?.text || "").includes("Access denied"));
    console.log("✓ Test 7 passed: write_file directory creation, content writing, overwrite protection & credential blocking verified.\n");

    // -------------------------------------------------
    // [Test 8] edit_block surgical replacement
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 8] edit_block surgical replacement");
    console.log("-------------------------------------------------");
    const editResp = await client.callTool({
      name: "edit_block",
      arguments: {
        path: newFilePath,
        target: "created by write_file",
        replacement: "surgically modified by edit_block",
      },
    });
    assert.equal(editResp.isError, undefined);
    assert.equal(
      fs.readFileSync(newFilePath, "utf8"),
      "console.log('surgically modified by edit_block');\n"
    );

    // Target not found error
    const notFoundEdit = await client.callTool({
      name: "edit_block",
      arguments: {
        path: newFilePath,
        target: "this phrase does not exist in the file",
        replacement: "abc",
      },
    });
    assert.equal(notFoundEdit.isError, true);
    assert.ok(((notFoundEdit.content as any)[0]?.text || "").includes("not found"));
    console.log("✓ Test 8 passed: edit_block surgical replacement and mismatch validation verified.\n");

    // -------------------------------------------------
    // [Test 9] search_files by name & glob pattern
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 9] search_files matching");
    console.log("-------------------------------------------------");
    const searchFilesResp = await client.callTool({
      name: "search_files",
      arguments: {
        path: WORKSPACE_DIR,
        pattern: "*.txt",
      },
    });
    assert.equal(searchFilesResp.isError, undefined);
    const searchFilesData = JSON.parse((searchFilesResp.content as any)[0]?.text || "{}");
    assert.ok(searchFilesData.totalFound >= 2);
    const foundNames = searchFilesData.files.map((f: any) => f.name);
    assert.ok(foundNames.includes("greeting.txt"));
    assert.ok(foundNames.includes("readme.txt"));
    console.log("✓ Test 9 passed: search_files glob matching verified.\n");

    // -------------------------------------------------
    // [Test 10] search_code keyword search
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 10] search_code keyword search");
    console.log("-------------------------------------------------");
    const searchCodeResp = await client.callTool({
      name: "search_code",
      arguments: {
        path: WORKSPACE_DIR,
        query: "surgically modified",
      },
    });
    assert.equal(searchCodeResp.isError, undefined);
    const searchCodeData = JSON.parse((searchCodeResp.content as any)[0]?.text || "{}");
    assert.ok(searchCodeData.totalFound >= 1);
    const match0 = searchCodeData.matches[0];
    assert.ok(match0.file.endsWith("created.txt"));
    assert.ok(match0.text.includes("surgically modified"));
    console.log("✓ Test 10 passed: search_code content discovery and line reporting verified.\n");

    // -------------------------------------------------
    // [Test 11] tail_file reading
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 11] tail_file operations");
    console.log("-------------------------------------------------");
    const multilineFile = path.join(WORKSPACE_DIR, "multiline.log");
    const sampleLines = Array.from({ length: 50 }, (_, i) => `Log entry line ${i + 1}`).join("\n") + "\n";
    fs.writeFileSync(multilineFile, sampleLines, "utf8");

    const tailResp = await client.callTool({
      name: "tail_file",
      arguments: {
        path: multilineFile,
        lines: 5,
      },
    });
    assert.equal(tailResp.isError, undefined);
    const tailData = JSON.parse((tailResp.content as any)[0]?.text || "{}");
    assert.ok(tailData.content.includes("Log entry line 50"));
    assert.ok(!tailData.content.includes("Log entry line 1\n"));
    console.log("✓ Test 11 passed: tail_file reverse reading verified.\n");

    // -------------------------------------------------
    // [Test 12] move_file operations
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 12] move_file operations");
    console.log("-------------------------------------------------");
    const srcFile = path.join(WORKSPACE_DIR, "multiline.log");
    const destFile = path.join(WORKSPACE_DIR, "renamed.log");
    const moveResp = await client.callTool({
      name: "move_file",
      arguments: {
        source: srcFile,
        destination: destFile,
      },
    });
    assert.equal(moveResp.isError, undefined);
    assert.ok(!fs.existsSync(srcFile));
    assert.ok(fs.existsSync(destFile));
    console.log("✓ Test 12 passed: move_file file renaming verified.\n");

    // -------------------------------------------------
    // [Test 13] create_directory operations
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 13] create_directory operations");
    console.log("-------------------------------------------------");
    const newDir = path.join(WORKSPACE_DIR, "folder", "subfolder");
    const createDirResp = await client.callTool({
      name: "create_directory",
      arguments: {
        path: newDir,
      },
    });
    assert.equal(createDirResp.isError, undefined);
    assert.ok(fs.existsSync(newDir) && fs.statSync(newDir).isDirectory());
    console.log("✓ Test 13 passed: create_directory creation verified.\n");

    // -------------------------------------------------
    // [Test 14] execute_command execution & security blocks
    // -------------------------------------------------
    console.log("-------------------------------------------------");
    console.log("[Test 14] execute_command operations");
    console.log("-------------------------------------------------");
    const execResp = await client.callTool({
      name: "execute_command",
      arguments: {
        command: "node -e \"console.log('AGENT_BRIDGE_EXEC_OK');\"",
      },
    });
    assert.equal(execResp.isError, undefined);
    const execData = JSON.parse((execResp.content as any)[0]?.text || "{}");
    assert.equal(execData.exitCode, 0);
    assert.ok(execData.stdout.includes("AGENT_BRIDGE_EXEC_OK"));

    // Verify dangerous command blocked
    const dangerousResp = await client.callTool({
      name: "execute_command",
      arguments: {
        command: "rm -rf /",
      },
    });
    assert.equal(dangerousResp.isError, true);
    assert.ok(((dangerousResp.content as any)[0]?.text || "").includes("Security Blocked"));
    console.log("✓ Test 14 passed: execute_command execution & safety blocking verified.\n");

  } finally {
    await client.close();
  }

  console.log("=================================================");
  console.log("  All local-fs tests passed successfully!        ");
  console.log("=================================================");
}

runLocalFsTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
