use crate::config::resolve_paths;
use crate::data::run_data;
use crate::doctor::run_doctor;
use crate::observe::{run_observe, ObserveParams};
use crate::rules::RulesEngine;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const MAX_LINE_BYTES: usize = 1 << 20;

pub fn run_stdio_server() -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    serve(stdin.lock(), stdout.lock());
    0
}

/// Serve JSON-RPC lines from `input` to `out` until EOF or a write error.
pub fn serve<R: BufRead, W: Write>(mut input: R, mut out: W) {
    let mut buf = Vec::new();
    loop {
        let resp = match read_line_capped(&mut input, &mut buf, MAX_LINE_BYTES) {
            Err(_) | Ok(LineRead::Eof) => break,
            Ok(LineRead::TooLong) => Some(rpc_error(
                -32600,
                format!("Invalid Request: line too long (> {MAX_LINE_BYTES} bytes)"),
            )),
            Ok(LineRead::Line) => match std::str::from_utf8(&buf) {
                Err(e) => Some(rpc_error(-32700, format!("Parse error: invalid UTF-8: {e}"))),
                Ok(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    handle_line(trimmed)
                }
            },
        };
        if let Some(resp) = resp {
            if let Ok(serialized) = serde_json::to_string(&resp) {
                if writeln!(out, "{serialized}").is_err() || out.flush().is_err() {
                    break;
                }
            }
        }
    }
}

enum LineRead {
    Eof,
    Line,
    TooLong,
}

fn rpc_error(code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": Value::Null,
        "error": { "code": code, "message": message }
    })
}

/// Read one '\n'-terminated line into `buf` (without the newline), keeping at most `cap`
/// bytes in memory. An over-long line is drained to its newline and reported as TooLong.
fn read_line_capped<R: BufRead>(r: &mut R, buf: &mut Vec<u8>, cap: usize) -> io::Result<LineRead> {
    buf.clear();
    let mut too_long = false;
    let mut seen_any = false;
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if too_long {
                LineRead::TooLong
            } else if seen_any {
                LineRead::Line
            } else {
                LineRead::Eof
            });
        }
        seen_any = true;
        let (take, done) = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => (i, true),
            None => (chunk.len(), false),
        };
        if !too_long {
            if buf.len() + take > cap {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&chunk[..take]);
            }
        }
        r.consume(if done { take + 1 } else { take });
        if done {
            return Ok(if too_long { LineRead::TooLong } else { LineRead::Line });
        }
    }
}

pub fn handle_line(raw: &str) -> Option<Value> {
    let req: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return Some(rpc_error(-32700, format!("Parse error: {e}"))),
    };
    if req.is_array() {
        return Some(rpc_error(-32600, "Invalid Request: batch not supported".to_string()));
    }
    if !req.is_object() {
        return Some(rpc_error(-32600, "Invalid Request: expected a JSON object".to_string()));
    }
    handle_request(&req)
}

pub fn handle_request(req: &Value) -> Option<Value> {
    let id = req.get("id").cloned();
    // A message with no method is a response from the client: ignore silently.
    let method = req.get("method").and_then(Value::as_str)?;
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    // Notifications (no id or id is null) MUST NOT emit a response.
    if id.is_none() || id.as_ref() == Some(&Value::Null) {
        return None;
    }
    let id = id.unwrap_or(Value::Null);

    let response = match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .filter(|v| SUPPORTED_VERSIONS.contains(v))
                    .unwrap_or(PROTOCOL_VERSION),
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "harness",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }
        }),
        "ping" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tool_definitions() }
        }),
        "tools/call" => {
            match call_tool(&params) {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err(msg) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32602, "message": msg }
                }),
            }
        }
        other => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {other}") }
        }),
    };

    Some(response)
}

pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "harness_observe",
            "description": "Read-only audit usage summary grouped by cmd, tool, mcp, hook, or event.",
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true
            },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": {
                        "type": "string",
                        "description": "Lookback window (e.g. '7d', '24h', '30m', or 'YYYY-MM-DD'). Default '7d'."
                    },
                    "by": {
                        "type": "string",
                        "enum": ["cmd", "tool", "mcp", "hook", "event", "model", "agent", "decision"],
                        "description": "Grouping dimension. Default 'cmd'."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 200,
                        "description": "Maximum number of rows (default 20)."
                    },
                    "project": {
                        "type": "string",
                        "description": "Optional project filter."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Workspace directory path."
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "harness_data",
            "description": "Read-only data zone and registry inspection (ls, stat, scan, retention).",
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true
            },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["ls", "stat", "scan", "retention"],
                        "description": "Data inspection action."
                    },
                    "zone": {
                        "type": "string",
                        "enum": ["system", "knowledge", "workspaces", "external", "_inbox"],
                        "description": "Optional zone filter."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Workspace directory path."
                    }
                },
                "required": ["action"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "harness_doctor",
            "description": "Read-only diagnostics for harness binary, rules, hooks, registry, and audit root.",
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true
            },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {
                        "type": "string",
                        "description": "Workspace directory path."
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "harness_policy",
            "description": "Read-only dump of active core protections and layered workspace rules.",
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true
            },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {
                        "type": "string",
                        "description": "Workspace directory path."
                    }
                },
                "additionalProperties": false
            }
        }),
    ]
}

/// Optional string argument; a present value of the wrong type is an invalid-params error.
fn opt_str(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("invalid params: '{key}' must be a string")),
    }
}

/// Err = JSON-RPC invalid params (-32602); Ok = tool result (tool failures set isError).
fn call_tool(params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid params: missing tool name".to_string())?;
    if !tool_definitions().iter().any(|t| t["name"] == name) {
        return Err(format!("unknown tool: {name}"));
    }
    let args = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(v) if v.is_object() => v.clone(),
        Some(_) => return Err("invalid params: 'arguments' must be an object".to_string()),
    };
    let cwd = opt_str(&args, "cwd")?;

    // Validate all arguments before running anything.
    let obs_params = if name == "harness_observe" {
        let limit = match args.get("limit") {
            None | Some(Value::Null) => None,
            Some(v) => match v.as_u64() {
                Some(n) if (1..=200).contains(&n) => Some(n as usize),
                _ => return Err("invalid params: 'limit' must be an integer 1..200".to_string()),
            },
        };
        Some(ObserveParams {
            since: opt_str(&args, "since")?,
            by: opt_str(&args, "by")?,
            limit,
            project: opt_str(&args, "project")?,
        })
    } else {
        None
    };
    let (action, zone) = if name == "harness_data" {
        let action = opt_str(&args, "action")?
            .ok_or_else(|| "invalid params: 'action' is required".to_string())?;
        (action, opt_str(&args, "zone")?)
    } else {
        (String::new(), None)
    };
    let paths = resolve_paths(cwd.as_deref());

    let res: Result<Value, String> = match name {
        "harness_observe" => {
            let obs_params = obs_params.expect("built for harness_observe");
            run_observe(&paths, &obs_params).and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
        }
        "harness_data" => run_data(&paths, &action, zone.as_deref()),
        "harness_doctor" => {
            let rep = run_doctor(&paths);
            serde_json::to_value(rep).map_err(|e| e.to_string())
        }
        "harness_policy" => {
            let engine = RulesEngine::load_for_workspace(&paths.workspace);
            Ok(engine.policy_dump(&paths.workspace))
        }
        _ => unreachable!("tool name validated above"),
    };

    Ok(match res {
        Ok(val) => {
            let text = serde_json::to_string_pretty(&val).unwrap_or_else(|_| val.to_string());
            json!({
                "content": [{ "type": "text", "text": text }],
                "isError": false
            })
        }
        Err(err) => json!({
            "content": [{ "type": "text", "text": err }],
            "isError": true
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_list_exposes_exactly_four_tools() {
        let req = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        let resp = handle_request(&req).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 4);
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec![
                "harness_observe",
                "harness_data",
                "harness_doctor",
                "harness_policy"
            ]
        );
        for t in tools {
            assert_eq!(t["annotations"]["readOnlyHint"], json!(true));
        }
    }

    #[test]
    fn notifications_return_none_and_ping_works() {
        let notif = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        assert!(handle_request(&notif).is_none());

        let ping = json!({"jsonrpc": "2.0", "id": 2, "method": "ping"});
        let resp = handle_request(&ping).unwrap();
        assert_eq!(resp["id"], json!(2));
        assert_eq!(resp["result"], json!({}));
    }

    fn serve_bytes(input: &[u8]) -> Vec<Value> {
        let mut out = Vec::new();
        serve(std::io::Cursor::new(input.to_vec()), &mut out);
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    const PING8: &[u8] = b"{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"ping\"}\n";

    #[test]
    fn non_utf8_line_gives_parse_error_and_server_survives() {
        let mut input = vec![0xff, 0xfe, b'\n'];
        input.extend_from_slice(PING8);
        let resps = serve_bytes(&input);
        assert_eq!(resps.len(), 2, "{resps:?}");
        assert_eq!(resps[0]["error"]["code"], json!(-32700));
        assert_eq!(resps[1]["id"], json!(8));
    }

    #[test]
    fn oversize_line_is_rejected_and_server_survives() {
        let mut input = vec![b'a'; MAX_LINE_BYTES + 10];
        input.push(b'\n');
        input.extend_from_slice(PING8);
        let resps = serve_bytes(&input);
        assert_eq!(resps.len(), 2, "{}", resps.len());
        assert!(resps[0]["error"]["code"].is_i64());
        assert!(resps[0]["error"]["message"].as_str().unwrap().contains("too long"));
        assert_eq!(resps[1]["id"], json!(8));
    }

    #[test]
    fn unknown_tool_and_bad_args_are_invalid_params() {
        let call = |name: &str, args: Value| {
            handle_request(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                "params":{"name":name,"arguments":args}}))
            .unwrap()
        };
        let r = call("nope", json!({}));
        assert_eq!(r["error"]["code"], json!(-32602), "{r}");
        let r = call("harness_observe", json!({"limit": "abc"}));
        assert_eq!(r["error"]["code"], json!(-32602), "{r}");
        let r = call("harness_observe", json!({"since": 5}));
        assert_eq!(r["error"]["code"], json!(-32602), "{r}");
    }

    #[test]
    fn initialize_schema_and_notifications_get_no_reply() {
        let resps = serve_bytes(
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n",
        );
        assert_eq!(resps.len(), 2);
        assert_eq!(resps[0]["result"]["protocolVersion"], json!(PROTOCOL_VERSION));
        assert!(resps[0]["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resps[0]["result"]["serverInfo"]["name"], json!("harness"));
        for t in resps[1]["result"]["tools"].as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], json!("object"));
            assert!(t["description"].is_string());
        }
    }

    #[test]
    fn non_object_and_batch_are_invalid_request_and_responses_ignored() {
        let resps = serve_bytes(
            b"42\n\"x\"\n[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}]\n{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{}}\n",
        );
        assert_eq!(resps.len(), 3, "{resps:?}");
        for r in &resps {
            assert_eq!(r["error"]["code"], json!(-32600), "{r}");
            assert_eq!(r["id"], Value::Null);
        }
        assert!(resps[2]["error"]["message"].as_str().unwrap().contains("batch not supported"));
    }

    #[test]
    fn initialize_echoes_supported_version_else_latest() {
        let init = |v: &str| {
            handle_request(&json!({"jsonrpc":"2.0","id":1,"method":"initialize",
                "params":{"protocolVersion": v}}))
            .unwrap()["result"]["protocolVersion"]
                .clone()
        };
        assert_eq!(init("2024-11-05"), json!("2024-11-05"));
        assert_eq!(init("2025-03-26"), json!("2025-03-26"));
        assert_eq!(init("1999-01-01"), json!(PROTOCOL_VERSION));
        assert_eq!(PROTOCOL_VERSION, "2025-06-18");
    }

    #[test]
    fn tools_call_works_for_all_four_tools() {
        let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();
        for (name, args) in [
            ("harness_doctor", json!({"cwd": cwd})),
            ("harness_policy", json!({"cwd": cwd})),
            ("harness_data", json!({"action": "ls", "cwd": cwd})),
            ("harness_observe", json!({"by": "tool", "since": "1d", "cwd": cwd})),
        ] {
            let req = json!({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/call",
                "params": { "name": name, "arguments": args }
            });
            let resp = handle_request(&req).unwrap();
            assert_eq!(resp["result"]["isError"], json!(false), "{name}: {resp}");
            let text = resp["result"]["content"][0]["text"].as_str().unwrap();
            assert!(serde_json::from_str::<Value>(text).is_ok(), "{name}");
        }
    }
}
