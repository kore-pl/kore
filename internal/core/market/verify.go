package market

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/pengtang1024/kore/pkg/pluginapi"
)

// 索引级 ed25519 公钥（32 字节 hex，内置于二进制，信任根）。
// 与 kore-plugins/index/plugins.json.sig 的演示密钥配对；轮换须留旧公钥兼容窗口（提案 0002 §2 M2-B）。
const IndexPublicKeyHex = "071dffb0eb84505084c950eae13f72bd20760585ee8f3a918db34fae610991d8"

var (
	// ErrUnsigned 表示索引未签名或验签失败（默认拒绝）。
	ErrUnsigned = errors.New("market: 索引未签名或验签失败")
	// ErrIO 表示索引文件读取失败。
	ErrIO = errors.New("market: 索引文件读取失败")
	// ErrSchema 表示索引结构非法。
	ErrSchema = errors.New("market: 索引结构非法")
)

// restartHintDetail 是验签失败的结构化提示：索引刚重签/换公钥时，旧 kored 进程
// 仍持有旧公钥，唯一恢复动作是重启内核重新载入公钥。前端据此显示醒目提示条。
const restartHintDetail = `{"requires_restart":true,"hint":"索引签名校验失败：若刚更新过索引，需重启 kored 重新载入公钥"}`

// signatureError 构造带 requires_restart 提示的 E_UNAUTHORIZED（不改变验签判定）。
func signatureError(message string) *pluginapi.Error {
	return &pluginapi.Error{
		Code: pluginapi.E_UNAUTHORIZED, Message: message,
		Detail: []byte(restartHintDetail),
	}
}

// verifySignature 用内置公钥验 .sig 对 data 的 raw ed25519 签名。
// 信任根固定在二进制常量，不接受外部指定（密钥轮换须改常量并留兼容窗口）。
func verifySignature(data, sig []byte) error {
	pub, err := hex.DecodeString(IndexPublicKeyHex)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return protocolError(pluginapi.E_INTERNAL, "内置索引公钥非法")
	}
	return verifyWithKey(pub, data, sig)
}

// verifyWithKey 是验签内核；pub 由调用方注入，便于测试配对密钥做正反验证。
// 未签名 / 验签失败一律返回 *pluginapi.Error（E_UNAUTHORIZED）。
func verifyWithKey(pub, data, sig []byte) error {
	if len(pub) != ed25519.PublicKeySize {
		return protocolError(pluginapi.E_INTERNAL, "索引公钥长度非法")
	}
	if len(sig) != ed25519.SignatureSize {
		return signatureError("索引签名缺失或格式错误：若刚更新过索引，需重启 kored 重新载入公钥")
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), data, sig) {
		return signatureError("索引签名校验失败：若刚更新过索引，需重启 kored 重新载入公钥")
	}
	return nil
}

// readIndexFiles 读取索引本体与签名文件；路径固定在 index_dir 下，不接受外部指定。
func readIndexFiles(indexDir string) (data, sig []byte, err error) {
	data, err = os.ReadFile(filepath.Join(indexDir, "plugins.json"))
	if err != nil {
		return nil, nil, fmt.Errorf("%w: 读取 plugins.json: %v", ErrIO, err)
	}
	// .sig 缺失属于"未签名"，不是 IO 故障：返回 nil 交给验签层统一判 E_UNAUTHORIZED。
	sig, err = os.ReadFile(filepath.Join(indexDir, "plugins.json.sig"))
	if err != nil {
		if os.IsNotExist(err) {
			return data, nil, nil
		}
		return nil, nil, fmt.Errorf("%w: 读取 plugins.json.sig: %v", ErrIO, err)
	}
	return data, sig, nil
}

func protocolError(code, message string, detail ...string) *pluginapi.Error {
	e := &pluginapi.Error{Code: code, Message: message}
	if len(detail) > 0 {
		e.Detail = []byte(detail[0])
	}
	return e
}
