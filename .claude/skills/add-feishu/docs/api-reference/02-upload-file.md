# 上传文件

调用该接口将本地文件上传至开放平台，支持上传音频、视频、文档等文件类型。上传后接口会返回文件的 Key，使用该 Key 值可以调用其他 OpenAPI。例如，调用[发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)接口，发送文件。

## 前提条件

应用需要开启[机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)。

## 使用限制

文件大小不得超过 30 MB，且不允许上传空文件。

## 请求

基本 | &nbsp;
---|---
HTTP URL | https://open.feishu.cn/open-apis/im/v1/files
HTTP Method | POST
接口频率限制 | [1000 次/分钟、50 次/秒](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)
支持的应用类型 | Custom App、Store App
权限要求<br>**调用该 API 所需的权限。开启其中任意一项权限即可调用**<br>开启任一权限即可 | 获取与上传图片或文件资源 (im:resource)<br>上传文件V2(im:resource:upload)

### 请求头

名称 | 类型 | 必填 | 描述
---|---|---|---
Authorization | string | 是 | `tenant_access_token`<br>**值格式**："Bearer `access_token`"<br>**示例值**："Bearer t-7f1bcd13fc57d46bac21793a18e560"<br>[了解更多：如何选择与获取 access token](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-choose-which-type-of-token-to-use)
Content-Type | string | 是 | **示例值**："multipart/form-data; boundary=---7MA4YWxkTrZu0gW"

### 请求体

名称 | 类型 | 必填 | 描述
---|---|---|---
file_type | string | 是 | 待上传的文件类型<br>**示例值**："mp4"<br>**可选值有**：<br>- opus：OPUS 音频文件。其他格式的音频文件，请转为 OPUS 格式后上传。可使用 ffmpeg 转换格式：`ffmpeg -i  SourceFile.mp3 -acodec libopus -ac 1 -ar 16000 TargetFile.opus`<br>- mp4：MP4 格式视频文件<br>- pdf：PDF 格式文件<br>- doc：DOC 格式文件<br>- xls：XLS 格式文件<br>- ppt：PPT 格式文件<br>- stream：stream 格式文件。若上传文件不属于以上枚举类型，可以使用 stream 格式
file_name | string | 是 | 带后缀的文件名<br>**示例值**："测试视频.mp4"
duration | int | 否 | 文件的时长（视频、音频），单位：毫秒。不传值时无法显示文件的具体时长。<br>**示例值**：3000
file | file | 是 | 文件内容，具体的传值方式可参考请求体示例。<br>**注意**：文件大小不得超过 30 MB，且不允许上传空文件。<br>**示例值**：二进制文件

### 请求体示例

```HTTP
---7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="file_type";

mp4
---7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="file_name";

测试视频.mp4
---7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="duration";

3000
---7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="file";
Content-Type: application/octet-stream

二进制文件
---7MA4YWxkTrZu0gW
```
以下示例代码中需要自行替换文件路径和鉴权Token

**cURL示例**
```
curl --location --request POST 'https://open.feishu.cn/open-apis/im/v1/files' \
--header 'Authorization: Bearer t-39eec8560faa3dded7971873eb649fd40e70e0f1' \
--form 'file_type="mp4"' \
--form 'file_name="测试视频.mp4"' \
--form 'duration="3000"' \
--form 'file=@"/path/测试视频.mp4"'
```

**HTTP示例**
```
POST /open-apis/im/v1/files HTTP/1.1
Host: open.feishu.cn
Authorization: Bearer t-ddf4732fda4aa8a8b1639ee42e8477001d8d5f7c
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Length: 471

----WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="file_type"

mp4
----WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="file"; filename="测试视频.mp4"
Content-Type: <Content-Type header here>

(data)
----WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="duration"

3000
----WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="file_name"

测试视频.mp4
----WebKitFormBoundary7MA4YWxkTrZu0gW
```

**Python请求示例**
```
import requests
from requests_toolbelt import MultipartEncoder
# 请注意使用时替换文件path和Authorization
def upload():
  url = "https://open.feishu.cn/open-apis/im/v1/files"
  form = {'file_type': 'stream',
          'file_name': 'text.txt',
          'file':  ('text.txt', open('path/text.txt', 'rb'), 'text/plain')} # 需要替换具体的path  具体的格式参考  https://www.w3school.com.cn/media/media_mimeref.asp
  multi_form = MultipartEncoder(form)
  headers = {
    'Authorization': 'Bearer xxx', ## 获取tenant_access_token, 需要替换为实际的token
  }
  headers['Content-Type'] = multi_form.content_type
  response = requests.request("POST", url, headers=headers, data=multi_form)
  print(response.headers['X-Tt-Logid']) # for debug or oncall
  print(response.content) # Print Response
# Press the green button in the gutter to run the script.

if __name__ == '__main__':
    upload()
```

## 响应

### 响应体

名称 | 类型 | 描述
---|---|---
code | int | 错误码，非 0 表示失败
msg | string | 错误描述
data | \- | \-
file_key | string | 文件的 Key

### 响应体示例
```json
{
    "code": 0,
    "msg": "success",
    "data": {
        "file_key": "file_456a92d6-c6ea-4de4-ac3f-7afcf44ac78g"
    }
}
```

### 错误码

HTTP状态码 | 错误码 | 描述 | 排查建议
---|---|---|---
400 | 232096 | Meta writing has stopped, please try again later. | 应用信息被停写，请稍后重试。
400 | 234001 | Invalid request param. | 请求参数无效，请根据接口文档描述检查请求参数是否正确。
401 | 234002 | Unauthorized. | 接口鉴权失败，请咨询[技术支持](https://applink.feishu.cn/TLJpeNdW)。
400 | 234006 | The file size exceed the max value. | 资源大小超出限制。<br>- 文件限制：不超过 30 MB<br>- 图片限制：不超过 10 MB
400 | 234007 | App does not enable bot feature. | 应用没有启用机器人能力。启用方式参见[如何启用机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)。
400 | 234010 | File's size can't be 0. | 请勿上传大小为 0 的文件。
400 | 234041 | Tenant master key has been deleted, please contact the tenant administrator. | 租户加密密钥被删除，请联系租户管理员。
400 | 234042 | Hybrid deployment tenant storage error, such as full storage space, please contact tenant administrator. | 请求出现混部租户存储错误，如存储空间已满等，请联系租户管理员或[技术支持](https://applink.feishu.cn/TLJpeNdW)。

更多错误码信息，参见[通用错误码](https://open.feishu.cn/document/ukTMukTMukTM/ugjM14COyUjL4ITN)。
