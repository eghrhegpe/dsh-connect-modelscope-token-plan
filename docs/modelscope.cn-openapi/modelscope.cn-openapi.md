User​Copy link
用户相关接口


GET
/users/me
获取当前用户信息
​Copy link
Copy endpoint URL

Models​Copy link
模型相关接口


GET
/models
获取模型列表
​Copy link
Copy endpoint URL

POST
/models
创建通用模型仓库
​Copy link
Copy endpoint URL

GET
/models/{owner}/{repo_name}
获取模型详情
​Copy link
Copy endpoint URL

PUT
/models/{owner}/{repo_name}/category
设置/变更模型类型
​Copy link
Copy endpoint URL

PATCH
/models/{owner}/{repo_name}/category
更新模型专区与已有 tag 元数据
​Copy link
Copy endpoint URL

GET
/model/aigc/options
查询 AIGC 模型配置项枚举
​Copy link
Copy endpoint URL

GET
/model/science/options
查询科学模型配置项枚举
​Copy link
Copy endpoint URL

PATCH
/models/{owner}/{repo_name}/settings
更新模型通用设置
​Copy link
Copy endpoint URL

DEL
/models/{owner}/{repo_name}/files
单次 commit 原子批量删除文件
​Copy link
Copy endpoint URL

GET
/models/options
获取模型任务与许可证选项
​Copy link
Copy endpoint URL

Datasets​Copy link
数据集相关接口


GET
/datasets
获取数据集列表
​Copy link
Copy endpoint URL

POST
/datasets
创建通用数据集仓库
​Copy link
Copy endpoint URL

GET
/datasets/{owner}/{repo_name}
获取数据集详情
​Copy link
Copy endpoint URL

PUT
/datasets/{owner}/{repo_name}/category
设置数据集类型
​Copy link
Copy endpoint URL

PATCH
/datasets/{owner}/{repo_name}/category
局部更新科学数据集字段
​Copy link
Copy endpoint URL

PATCH
/datasets/{owner}/{repo_name}/settings
更新数据集通用设置
​Copy link
Copy endpoint URL

DEL
/datasets/{owner}/{repo_name}/files
单次 commit 原子批量删除文件
​Copy link
Copy endpoint URL

GET
/dataset/science/options
获取科学数据集学科枚举
​Copy link
Copy endpoint URL

MCP​Copy link
MCP 服务相关接口


PUT
/mcp/servers
获取MCP服务列表
​Copy link
Copy endpoint URL

GET
/mcp/servers/operational
获取用户托管MCP服务列表
​Copy link
Copy endpoint URL

GET
/mcp/servers/{id}
获取指定MCP服务详情
​Copy link
Copy endpoint URL

POST
/mcp/servers/{id}/deploy
部署MCP服务
​Copy link
Copy endpoint URL

DEL
/mcp/servers/{id}/undeploy
解除MCP服务部署
​Copy link
Copy endpoint URL

Studios​Copy link
创空间相关接口


GET
/studios
获取创空间列表
​Copy link
Copy endpoint URL

POST
/studios
创建创空间
​Copy link
Copy endpoint URL

GET
/studios/hardware
查询可用硬件配置
​Copy link
Copy endpoint URL

GET
/studios/sdk-versions
查询可用 SDK 版本
​Copy link
Copy endpoint URL

GET
/studios/base-images
查询可用基础镜像
​Copy link
Copy endpoint URL

GET
/studios/{owner}/{repo_name}
获取创空间详情
​Copy link
Copy endpoint URL

PATCH
/studios/{owner}/{repo_name}/settings
更新创空间设置
​Copy link
Copy endpoint URL

GET
/studios/{owner}/{repo_name}/secrets
获取创空间密文变量列表
​Copy link
Copy endpoint URL

POST
/studios/{owner}/{repo_name}/secrets
添加创空间密文变量
​Copy link
Copy endpoint URL

PUT
/studios/{owner}/{repo_name}/secrets
更新创空间密文变量
​Copy link
Copy endpoint URL

DEL
/studios/{owner}/{repo_name}/secrets
删除创空间密文变量
​Copy link
Copy endpoint URL

GET
/studios/{owner}/{repo_name}/variables
获取创空间明文变量列表
​Copy link
Copy endpoint URL

POST
/studios/{owner}/{repo_name}/variables
添加创空间明文变量
​Copy link
Copy endpoint URL

PUT
/studios/{owner}/{repo_name}/variables
更新创空间明文变量
​Copy link
Copy endpoint URL

DEL
/studios/{owner}/{repo_name}/variables
删除创空间明文变量
​Copy link
Copy endpoint URL

POST
/studios/{owner}/{repo_name}/deploy
部署创空间
​Copy link
Copy endpoint URL

POST
/studios/{owner}/{repo_name}/stop
停止创空间
​Copy link
Copy endpoint URL

GET
/studios/{owner}/{repo_name}/logs/{log_type}
获取创空间日志
​Copy link
Copy endpoint URL

Skills​Copy link
技能相关接口


GET
/skills
获取技能列表
​Copy link
Copy endpoint URL

POST
/skills
创建技能
​Copy link
Copy endpoint URL

GET
/skills/{id}
获取指定技能详情
​Copy link
Copy endpoint URL

PATCH
/skills/{owner}/{skill_name}/settings
更新技能设置
​Copy link
Copy endpoint URL

AgentHub​Copy link
AgentHub 相关接口


GET
/agents
获取 Agent 列表
​Copy link
Copy endpoint URL

POST
/agents
创建 Agent
​Copy link
Copy endpoint URL

GET
/agents/{id}
查看 Agent 详情
​Copy link
Copy endpoint URL

Files​Copy link
文件上传相关接口


POST
/files/upload
上传文件
​Copy link
Copy endpoint URL

Agent-IDP​Copy link
Agent-IDP身份认证服务（beta版本）


POST
/agent_ids
创建 Agent 身份
​Copy link
Copy endpoint URL

GET
/agent_ids/{agent_id}
获取 Agent 身份详情
​Copy link
Copy endpoint URL

PATCH
/agent_ids/{agent_id}
更新 Agent 身份设置
​Copy link
Copy endpoint URL

DEL
/agent_ids/{agent_id}
删除 Agent 身份
​Copy link
Copy endpoint URL

PUT
/agent_ids/{agent_id}/key_pairs
重置 Agent 密钥对
​Copy link
Copy endpoint URL

POST
/agent_ids/{agent_id}/paused
启用/停用 Agent
​Copy link
Copy endpoint URL

GET
/agent_ids/{agent_id}/jwt_id_tokens
获取 Agent 的 Token 签发记录
​Copy link
Copy endpoint URL

GET
/users/{username}/agent_ids
获取指定用户的 Agent 身份列表
​Copy link
Copy endpoint URL

POST
/agent_id/token
签发 Agent Token
​Copy link
Copy endpoint URL

GET
/agent_id/.well-known/agentid-configuration
获取 Agent IDP OIDC 配置
​Copy link
Copy endpoint URL

GET
/agent_id/.well-known/agentid-jwks
获取 Agent IDP JWKS
​Copy link
Copy endpoint URL

Magicube​Copy link
魔粒体系相关接口


GET
/magicubes/balance
查询余额
​Copy link
Copy endpoint URL

Collections​Copy link
合集相关接口


GET
/collections
获取 Collection 列表
​Copy link
Copy endpoint URL

POST
/collections
创建 Collection
​Copy link
Copy endpoint URL

GET
/collections/{owner}/{slug}
获取 Collection 详情
​Copy link
Copy endpoint URL

PATCH
/collections/{owner}/{slug}
更新 Collection
​Copy link
Copy endpoint URL

DEL
/collections/{owner}/{slug}
删除 Collection
​Copy link
Copy endpoint URL

GET
/collections/{owner}/{slug}/items
获取 Collection 条目列表
​Copy link
Copy endpoint URL

POST
/collections/{owner}/{slug}/items
添加 Collection 条目
​Copy link
Copy endpoint URL

PATCH
/collections/{owner}/{slug}/items
批量更新 Collection 条目
​Copy link
Copy endpoint URL

PATCH
/collections/{owner}/{slug}/items/{item_type}/{item_object_id}
更新单个 Collection 条目
​Copy link
Copy endpoint URL

DEL
/collections/{owner}/{slug}/items/{item_type}/{item_object_id}
移除 Collection 条目
​Copy link
Copy endpoint URL

Galleries​Copy link
Gallery 相关接口


POST
/galleries
创建 Gallery
​Copy link
Copy endpoint URL

Agent Playground​Copy link
实验场（Agent Playground）相关接口（beta版本）


POST
/agent/playground/instances
创建实验场实例
​Copy link
Copy endpoint URL

GET
/agent/playground/instances
获取实验场实例列表
​Copy link
Copy endpoint URL

POST
/agent/playground/instances/from-agent-hub
从 Agent Hub 创建实验场实例
​Copy link
Copy endpoint URL

GET
/agent/playground/instances/{uuid}
获取实验场实例详情
​Copy link
Copy endpoint URL

PUT
/agent/playground/instances/{uuid}
更新实验场实例元信息
​Copy link
Copy endpoint URL

DEL
/agent/playground/instances/{uuid}
删除实验场实例
​Copy link
Copy endpoint URL

POST
/agent/playground/instances/{uuid}/pause
暂停实验场实例
​Copy link
Copy endpoint URL

POST
/agent/playground/instances/{uuid}/resume
恢复实验场实例
​Copy link
Copy endpoint URL

POST
/agent/playground/instances/{uuid}/restart
冷重启实验场实例
​Copy link
Copy endpoint URL

GET
/agent/playground/instances/{uuid}/agents
获取实例内 Agent 信息
​Copy link
Copy endpoint URL

POST
/agent/playground/instances/{uuid}/setup/model
向实例下发模型配置
​Copy link
Copy endpoint URL

POST
/agent/playground/instances/{uuid}/setup/mcp
向实例下发 MCP 配置
​Copy link
Copy endpoint URL

POST
/agent/playground/instances/{uuid}/setup/skill
向实例下发 Skill
​Copy link
Copy endpoint URL

POST
/agent/playground/instances/{uuid}/import
向实例导入 Model / MCP / Skill
​Copy link
Copy endpoint URL

GET
/agent/playground/instances/{uuid}/notifications
拉取实例一次性通知