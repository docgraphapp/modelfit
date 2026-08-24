fn main() { println!("{}", serde_json::to_string_pretty(&modelfit_hardware::detect()).unwrap()); }
