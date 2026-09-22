#[tokio::test]
async fn measurement_classifier_input_fidelity_from_corpus() -> TestResult {
    let corpus_path = std::env::var("SWITCHYARD_FIDELITY_CORPUS")?;
    let corpus: Value = serde_json::from_slice(&std::fs::read(corpus_path)?)?;
    let cases = corpus["fidelity"]
        .as_array()
        .ok_or("fidelity corpus section must be an array")?;
    let provider = Arc::new(RecordingTypeSafeProvider::default());
    let state = type_safe_state_with_format_and_trigger(
        "http://127.0.0.1:1/v1",
        Arc::clone(&provider),
        WireFormat::OpenAiResponses,
        ClassifyTrigger::EveryRequest,
    )?
    .with_local_hop_capability("measurement-local-hop")?;
    let app = build_switchyard_router(state);

    for case in cases {
        let id = case["id"].as_str().ok_or("fidelity case requires an id")?;
        let mut request = json!({
            "model": "typesafe",
            "input": case["input"].clone(),
            "store": false,
            "stream": false
        });
        if let Some(fields) = case.get("requestFields").and_then(Value::as_object) {
            request
                .as_object_mut()
                .ok_or("request must be an object")?
                .extend(fields.clone());
        }
        let before = provider.inputs.lock().await.len();
        let response = send_with_headers(
            &app,
            "POST",
            "/v1/decision",
            Some(json!({
                "input_format": "openai_responses",
                "request": request
            })),
            &[(LOCAL_HOP_CAPABILITY_HEADER, "measurement-local-hop")],
        )
        .await?;
        assert_eq!(response.status, StatusCode::OK, "{id}: {}", response.text()?);
        let body = response.json()?;
        let inputs = provider.inputs.lock().await;
        if case["expectedZeroCalls"] == Value::Bool(true) {
            assert_eq!(inputs.len(), before, "{id}: expected zero classifier calls");
            assert_eq!(
                body["decision_evidence"]["reason_code"],
                case["expectedReason"],
                "{id}: fallback reason"
            );
            assert_eq!(
                body["decision_evidence"]["final_target"],
                "efficient",
                "{id}: fallback target"
            );
        } else {
            assert_eq!(inputs.len(), before + 1, "{id}: expected one classifier call");
            assert_eq!(
                inputs.last().map(|input| input.context.as_str()),
                case["expectedState"].as_str(),
                "{id}: exact outgoing classifier state"
            );
        }
    }
    Ok(())
}
