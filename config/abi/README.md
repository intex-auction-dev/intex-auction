# Contract ABIs

Place the application ABIs in this directory as ordinary JSON arrays.

Required first-release filenames are listed in `../deployments.json`, including `IMetadosis.json` for canonical Outbe WWD reads.

Example shape:

```json
[
  {
    "type": "function",
    "name": "example",
    "inputs": [],
    "outputs": [],
    "stateMutability": "view"
  }
]
```

No ABI source-commit pin, fingerprint registry, package publication or generation pipeline is required for the first release. Replace a JSON file deliberately when the application needs a different contract interface.
