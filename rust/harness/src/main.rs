mod audit;
mod cli;
mod config;
mod data;
mod doctor;
mod host;
mod mcp;
mod observe;
mod rules;

use clap::Parser;
use cli::Cli;
use host::Host;

fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("hook") {
        let rest: Vec<String> = args.collect();
        if let Some((host, ev)) = parse_fast_hook_args(&rest) {
            std::process::exit(cli::run_hook_fast(host, ev.as_deref()));
        }
    }

    let cli = Cli::parse();
    let code = cli::run(cli);
    std::process::exit(code);
}

fn parse_fast_hook_args(rest: &[String]) -> Option<(Host, Option<String>)> {
    let mut host: Option<Host> = None;
    let mut event: Option<String> = None;
    let mut i = 0;
    while i < rest.len() {
        let a = rest[i].as_str();
        if a == "--host" {
            let val = rest.get(i + 1)?.as_str();
            host = match val {
                "claude" => Some(Host::Claude),
                "agy" => Some(Host::Agy),
                _ => return None,
            };
            i += 2;
        } else if let Some(val) = a.strip_prefix("--host=") {
            host = match val {
                "claude" => Some(Host::Claude),
                "agy" => Some(Host::Agy),
                _ => return None,
            };
            i += 1;
        } else if a.starts_with('-') {
            return None;
        } else if event.is_none() {
            event = Some(a.to_string());
            i += 1;
        } else {
            return None;
        }
    }
    Some((host?, event))
}
