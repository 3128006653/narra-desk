package main

import (
	"encoding/json"
	"os"
	"testing"
)

// 契约向量在 `deploy/fsJailVectors.json` 声明。本测试保证：
// **JSON 里的每一条都有同名 Go 用例** —— 新增向量而忘记补实现会在这里变红，
// 而不是等到某天有人手工对照两份文件。
func TestEveryDeclaredVectorHasGoCase(t *testing.T) {
	raw, err := os.ReadFile("../deploy/fsJailVectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var doc struct {
		Cases []struct {
			Name string `json:"name"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("vectors file declares no cases")
	}

	implemented := map[string]bool{}
	for _, c := range jailCases() {
		implemented[c.name] = true
	}
	for _, c := range doc.Cases {
		if !implemented[c.Name] {
			t.Errorf("declared vector has no Go case: %q", c.Name)
		}
	}
	if len(doc.Cases) != len(jailCases()) {
		t.Errorf("vector count mismatch: declared %d, implemented %d", len(doc.Cases), len(jailCases()))
	}
}
