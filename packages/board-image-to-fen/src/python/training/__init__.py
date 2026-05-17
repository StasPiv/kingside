"""Training pipeline for the board-recog CNN (ADR-040, KS-2361).

Modules:
    dataset   — PyTorch Dataset over the v1 JSONL splits.
    model     — MobileNetV3-Small adapter for 13-class cell classification.
    train     — CLI training loop (Adam + cosine LR + early-stop).
    evaluate  — per-class / per-style accuracy + end-to-end FEN match.
    export_onnx — convert a trained checkpoint into an ONNX artefact.

This package is meant to run on a rented GPU (Google Colab, Lambda Labs).
It is *not* expected to run inside the agent container or in production.
See README.md for the recommended Colab procedure.
"""
