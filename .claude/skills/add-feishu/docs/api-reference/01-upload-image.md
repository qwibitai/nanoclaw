# 飞书 API 参考：上传图片

调用本接口将图片上传至飞书开放平台，支持上传 JPG、JPEG、PNG、WEBP、GIF、BMP、ICO、TIFF、HEIC 格式的图片，但需要注意 TIFF、HEIC 上传后会被转为 JPG 格式。

## 使用场景

如果需要发送图片消息，或者将图片作为头像，则需要先调用本接口将图片上传至开放平台，平台会返回一个图片标识（image_key），后续使用该 Key 值调用其他 API。例如：

- [发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)时，如果需要发送图片，则需要先调用本接口上传图片（上传时图片类型需要选择 **用于发送消息**），并使用返回结果中的 image_key 发送图片消息。
- [创建用户](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/create)时，如果需要设置用户头像，则需要先调用本接口将头像上传（上传时图片类型需要选择 **用于设置头像**），并使用返回结果中的 image_key 设置头像。

## 前提条件

应用需要开启[机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)。

## 使用限制

- 上传的图片大小不能超过 10 MB，且不支持上传大小为 0 的图片。
- 上传图片的分辨率限制：
	- GIF 图片分辨率不能超过 2000 x 2000，其他图片分辨率不能超过 12000 x 12000。
	- 用于设置头像的图片分辨率不能超过 4096 x 4096。

如需上传高分辨率图片，可使用[上传文件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/file/create)接口，将图片作为文件进行上传。注意该方式不支持将图片文件设置为头像。

## 请求

基本 | &nbsp;
---|---
HTTP URL | https://open.feishu.cn/open-apis/im/v1/images
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
image_type | string | 是 | 图片类型<br>**示例值**："message"<br>**可选值有**：<br>- message：用于发送消息<br>- avatar：用于设置头像
image | file | 是 | 图片内容。传值方式可以参考请求体示例。<br>**注意**：<br>- 上传的图片大小不能超过 10 MB，也不能上传大小为 0 的图片。<br>- 分辨率限制：<br>- GIF 图片分辨率不能超过 2000 x 2000，其他图片分辨率不能超过 12000 x 12000。<br>- 用于设置头像的图片分辨率不能超过 4096 x 4096。<br>**示例值**：二进制文件

### 请求体示例

```HTTP
---7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="image_type";

message
---7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="image";
Content-Type: application/octet-stream

二进制文件
---7MA4YWxkTrZu0gW
```

**cURL示例**

```
curl --location --request POST 'https://open.feishu.cn/open-apis/im/v1/images' \
--header 'Authorization: Bearer t-39eec8560faa3dded7971873eb649fd40e70e0f1' \
--header 'Content-Type: multipart/form-data' \
--form 'image_type="message"' \
--form 'image=@"/path/image.jpg"'
```

**HTTP示例**
```
POST /open-apis/im/v1/images HTTP/1.1
Host: open.feishu.cn
Authorization: Bearer t-ddf4732fda4aa8a8b1639ee42e8477001d8d5f7c
Content-Length: 285
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW

----WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="image_type"

message
----WebKitFormBoundary7MA4YWxkTrZu0gW
Content-Disposition: form-data; name="image"; filename="image.jpg"
Content-Type: image/jpeg

(data)
----WebKitFormBoundary7MA4YWxkTrZu0gW
```

**Python示例代码**
```
import requests
from requests_toolbelt import MultipartEncoder
# 输入pip install requests_toolbelt 安装依赖库

def uploadImage():
    url = "https://open.feishu.cn/open-apis/im/v1/images"
    form = {'image_type': 'message',
            'image': (open('path/testimage.png', 'rb'))}  # 需要替换具体的path 
    multi_form = MultipartEncoder(form)
    headers = {
        'Authorization': 'Bearer t-xxx',  ## 获取tenant_access_token, 需要替换为实际的token
    }
    headers['Content-Type'] = multi_form.content_type
    response = requests.request("POST", url, headers=headers, data=multi_form)
    print(response.headers['X-Tt-Logid'])  # for debug or oncall
    print(response.content)  # Print Response

if __name__ == '__main__':
    uploadImage()
```

## 响应

### 响应体

名称 | 类型 | 描述
---|---|---
code | int | 错误码，非 0 表示失败
msg | string | 错误描述
data | \- | \-
image_key | string | 图片的 Key

### 响应体示例
```json
{
    "code": 0,
    "data": {
        "image_key": "img_v2_xxx"
    },
    "msg": "success"
}
```

### 错误码

HTTP状态码 | 错误码 | 描述 | 排查建议
---|---|---|---
400 | 232096 | Meta writing has stopped, please try again later. | 应用信息被停写，请稍后再试。
400 | 234001 | Invalid request param. | 请求参数无效，请根据接口文档描述检查请求参数是否正确。
401 | 234002 | Unauthorized. | 接口鉴权失败，请咨询[技术支持](https://applink.feishu.cn/TLJpeNdW)。
400 | 234006 | The file size exceed the max value. | 资源大小超出限制。<br>- 文件限制：不超过 30 MB<br>- 图片限制：不超过 10 MB
400 | 234007 | App does not enable bot feature. | 应用没有启用机器人能力。启用方式参见[如何启用机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)。
400 | 234010 | File's size can't be 0. | 请勿上传大小为 0 的文件。
400 | 234011 | Can't regonnize the image format. | 不支持的图片格式。目前仅支持上传 JPG、JPEG、PNG、WEBP、GIF、BMP、ICO、TIFF、HEIC 格式的图片。
400 | 234039 | Image resolution exceeds limit. | 分辨率超出限制。<br>- GIF 图片分辨率不能大于 2000 x 2000<br>- 其他图片分辨率不能大于 12000 x 12000<br>- 用于设置头像的图片分辨率不能超过 4096 x 4096<br>如有需要，请使用[上传文件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/file/create)接口以文件形式上传高分辨率图片。
400 | 234041 | Tenant master key has been deleted, please contact the tenant administrator. | 租户加密密钥被删除，请联系租户管理员。
400 | 234042 | Hybrid deployment tenant storage error, such as full storage space, please contact tenant administrator. | 请求出现混部租户存储错误，如存储空间已满等，请联系租户管理员或[技术支持](https://applink.feishu.cn/TLJpeNdW)。

更多错误码信息，参见[通用错误码](https://open.feishu.cn/document/ukTMukTMukTM/ugjM14COyUjL4ITN)。

