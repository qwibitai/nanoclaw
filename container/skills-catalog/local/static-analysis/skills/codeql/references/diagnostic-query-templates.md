# Diagnostic Query Templates

Language-specific QL queries for enumerating sources and sinks recognized by CodeQL. Used during the data extensions creation process.

## Source Enumeration Query

All languages use the class `RemoteFlowSource`. The import differs per language.

### Import Reference

| Language | Imports | Class |
|----------|---------|-------|
| Python | `import python` + `import semmle.python.dataflow.new.RemoteFlowSources` | `RemoteFlowSource` |
| JavaScript | `import javascript` | `RemoteFlowSource` |
| Java | `import java` + `import semmle.code.java.dataflow.FlowSources` | `RemoteFlowSource` |
| Go | `import go` | `RemoteFlowSource` |
| C/C++ | `import cpp` + `import semmle.code.cpp.security.FlowSources` | `RemoteFlowSource` |
| C# | `import csharp` + `import semmle.code.csharp.security.dataflow.flowsources.Remote` | `RemoteFlowSource` |
| Ruby | `import ruby` + `import codeql.ruby.dataflow.RemoteFlowSources` | `RemoteFlowSource` |

### Template (Python — swap imports per table above)

```ql
/**
 * @name List recognized dataflow sources
 * @description Enumerates all locations CodeQL recognizes as dataflow sources
 * @kind problem
 * @id custom/list-sources
 */
import python
import semmle.python.dataflow.new.RemoteFlowSources

from RemoteFlowSource src
select src,
  src.getSourceType()
    + " | " + src.getLocation().getFile().getRelativePath()
    + ":" + src.getLocation().getStartLine().toString()
```

**Note:** `getSourceType()` is available on Python, Java, and C#. For Go, JavaScript, Ruby, and C++ replace the select with:
```ql
select src,
  src.getLocation().getFile().getRelativePath()
    + ":" + src.getLocation().getStartLine().toString()
```

---

## Sink Enumeration Queries

The Concepts API differs significantly across languages. Use the correct template.

### Concept Class Reference

| Concept | Python | JavaScript | Go | Ruby |
|---------|--------|------------|-----|------|
| SQL | `SqlExecution.getSql()` | `DatabaseAccess.getAQueryArgument()` | `SQL::QueryString` (is-a Node) | `SqlExecution.getSql()` |
| Command exec | `SystemCommandExecution.getCommand()` | `SystemCommandExecution.getACommandArgument()` | `SystemCommandExecution.getCommandName()` | `SystemCommandExecution.getAnArgument()` |
| File access | `FileSystemAccess.getAPathArgument()` | `FileSystemAccess.getAPathArgument()` | `FileSystemAccess.getAPathArgument()` | `FileSystemAccess.getAPathArgument()` |
| HTTP client | `Http::Client::Request.getAUrlPart()` | — | — | — |
| Decoding | `Decoding.getAnInput()` | — | — | — |
| XML parsing | — | — | — | `XmlParserCall.getAnInput()` |

### Python

```ql
/**
 * @name List recognized dataflow sinks
 * @description Enumerates security-relevant sinks CodeQL recognizes
 * @kind problem
 * @id custom/list-sinks
 */
import python
import semmle.python.Concepts

from DataFlow::Node sink, string kind
where
  exists(SqlExecution e | sink = e.getSql() and kind = "sql-execution")
  or
  exists(SystemCommandExecution e |
    sink = e.getCommand() and kind = "command-execution"
  )
  or
  exists(FileSystemAccess e |
    sink = e.getAPathArgument() and kind = "file-access"
  )
  or
  exists(Http::Client::Request r |
    sink = r.getAUrlPart() and kind = "http-request"
  )
  or
  exists(Decoding d | sink = d.getAnInput() and kind = "decoding")
  or
  exists(CodeExecution e | sink = e.getCode() and kind = "code-execution")
select sink,
  kind
    + " | " + sink.getLocation().getFile().getRelativePath()
    + ":" + sink.getLocation().getStartLine().toString()
```

### JavaScript / TypeScript

```ql
/**
 * @name List recognized dataflow sinks
 * @description Enumerates security-relevant sinks CodeQL recognizes
 * @kind problem
 * @id custom/list-sinks-js
 */
import javascript

from DataFlow::Node sink, string kind
where
  exists(DatabaseAccess e |
    sink = e.getAQueryArgument() and kind = "database-access"
  )
  or
  exists(SystemCommandExecution e |
    sink = e.getACommandArgument() and kind = "command-execution"
  )
  or
  exists(FileSystemAccess e |
    sink = e.getAPathArgument() and kind = "file-access"
  )
select sink,
  kind
    + " | " + sink.getLocation().getFile().getRelativePath()
    + ":" + sink.getLocation().getStartLine().toString()
```

### Go

```ql
/**
 * @name List recognized dataflow sinks
 * @description Enumerates security-relevant sinks CodeQL recognizes
 * @kind problem
 * @id custom/list-sinks-go
 */
import go
import semmle.go.frameworks.SQL

from DataFlow::Node sink, string kind
where
  sink instanceof SQL::QueryString and kind = "sql-query"
  or
  exists(SystemCommandExecution e |
    sink = e.getCommandName() and kind = "command-execution"
  )
  or
  exists(FileSystemAccess e |
    sink = e.getAPathArgument() and kind = "file-access"
  )
select sink,
  kind
    + " | " + sink.getLocation().getFile().getRelativePath()
    + ":" + sink.getLocation().getStartLine().toString()
```

### Ruby

```ql
/**
 * @name List recognized dataflow sinks
 * @description Enumerates security-relevant sinks CodeQL recognizes
 * @kind problem
 * @id custom/list-sinks-ruby
 */
import ruby
import codeql.ruby.Concepts

from DataFlow::Node sink, string kind
where
  exists(SqlExecution e | sink = e.getSql() and kind = "sql-execution")
  or
  exists(SystemCommandExecution e |
    sink = e.getAnArgument() and kind = "command-execution"
  )
  or
  exists(FileSystemAccess e |
    sink = e.getAPathArgument() and kind = "file-access"
  )
  or
  exists(CodeExecution e | sink = e.getCode() and kind = "code-execution")
select sink,
  kind
    + " | " + sink.getLocation().getFile().getRelativePath()
    + ":" + sink.getLocation().getStartLine().toString()
```

### Java

Java lacks a unified Concepts module. Use language-specific sink classes. The diagnostics query needs its own `qlpack.yml` with a `codeql/java-all` dependency — create it alongside the `.ql` files:

```yaml
# $DIAG_DIR/qlpack.yml
name: custom/diagnostics
version: 0.0.1
dependencies:
  codeql/java-all: "*"
```

Then run `codeql pack install` in the diagnostics directory before executing queries.

```ql
/**
 * @name List recognized dataflow sinks
 * @description Enumerates security-relevant sinks CodeQL recognizes
 * @kind problem
 * @id custom/list-sinks
 */
import java
import semmle.code.java.dataflow.DataFlow
import semmle.code.java.security.QueryInjection
import semmle.code.java.security.CommandLineQuery
import semmle.code.java.security.TaintedPathQuery
import semmle.code.java.security.XSS
import semmle.code.java.security.RequestForgery
import semmle.code.java.security.Xxe

from DataFlow::Node sink, string kind
where
  sink instanceof QueryInjectionSink and kind = "sql-injection"
  or
  sink instanceof CommandInjectionSink and kind = "command-injection"
  or
  sink instanceof TaintedPathSink and kind = "path-injection"
  or
  sink instanceof XssSink and kind = "xss"
  or
  sink instanceof RequestForgerySink and kind = "ssrf"
  or
  sink instanceof XxeSink and kind = "xxe"
select sink,
  kind
    + " | " + sink.getLocation().getFile().getRelativePath()
    + ":" + sink.getLocation().getStartLine().toString()
```

### C / C++

C++ uses a similar per-vulnerability-class pattern. Requires a `qlpack.yml` with `codeql/cpp-all` dependency (same approach as Java):

```yaml
# $DIAG_DIR/qlpack.yml
name: custom/diagnostics
version: 0.0.1
dependencies:
  codeql/cpp-all: "*"
```

Then run `codeql pack install` in the diagnostics directory before executing queries.

```ql
/**
 * @name List recognized dataflow sinks
 * @description Enumerates security-relevant sinks CodeQL recognizes
 * @kind problem
 * @id custom/list-sinks-cpp
 */
import cpp
import semmle.code.cpp.dataflow.DataFlow
import semmle.code.cpp.security.CommandExecution
import semmle.code.cpp.security.FileAccess
import semmle.code.cpp.security.BufferWrite

from DataFlow::Node sink, string kind
where
  exists(FunctionCall call |
    sink.asExpr() = call.getAnArgument() and
    call.getTarget().hasGlobalOrStdName("system") and
    kind = "command-injection"
  )
  or
  exists(FunctionCall call |
    sink.asExpr() = call.getAnArgument() and
    call.getTarget().hasGlobalOrStdName(["fopen", "open", "freopen"]) and
    kind = "file-access"
  )
  or
  exists(FunctionCall call |
    sink.asExpr() = call.getAnArgument() and
    call.getTarget().hasGlobalOrStdName(["sprintf", "strcpy", "strcat", "gets"]) and
    kind = "buffer-write"
  )
  or
  exists(FunctionCall call |
    sink.asExpr() = call.getAnArgument() and
    call.getTarget().hasGlobalOrStdName(["execl", "execle", "execlp", "execv", "execvp", "execvpe", "popen"]) and
    kind = "command-execution"
  )
select sink,
  kind
    + " | " + sink.getLocation().getFile().getRelativePath()
    + ":" + sink.getLocation().getStartLine().toString()
```

### C\#

C# uses per-vulnerability sink classes. Requires a `qlpack.yml` with `codeql/csharp-all` dependency:

```yaml
# $DIAG_DIR/qlpack.yml
name: custom/diagnostics
version: 0.0.1
dependencies:
  codeql/csharp-all: "*"
```

Then run `codeql pack install` in the diagnostics directory before executing queries.

```ql
/**
 * @name List recognized dataflow sinks
 * @description Enumerates security-relevant sinks CodeQL recognizes
 * @kind problem
 * @id custom/list-sinks-csharp
 */
import csharp
import semmle.code.csharp.dataflow.DataFlow
import semmle.code.csharp.security.dataflow.SqlInjectionQuery
import semmle.code.csharp.security.dataflow.CommandInjectionQuery
import semmle.code.csharp.security.dataflow.TaintedPathQuery
import semmle.code.csharp.security.dataflow.XSSQuery

from DataFlow::Node sink, string kind
where
  sink instanceof SqlInjection::Sink and kind = "sql-injection"
  or
  sink instanceof CommandInjection::Sink and kind = "command-injection"
  or
  sink instanceof TaintedPath::Sink and kind = "path-injection"
  or
  sink instanceof XSS::Sink and kind = "xss"
select sink,
  kind
    + " | " + sink.getLocation().getFile().getRelativePath()
    + ":" + sink.getLocation().getStartLine().toString()
```
