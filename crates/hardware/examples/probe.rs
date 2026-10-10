fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&mmf_hardware::detect()).unwrap()
    );
}
