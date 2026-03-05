// Cloudflare Worker - 内容解析统一API（增强版）
// 支持多接口按序号选择，严格错误处理，北京时间标准化时间
// 元数据保留原始解析接口JSON数据

// 预定义解析接口列表（序号从1开始）
const API_LIST = [
  'https://apis.kit9.cn/api/aggregate_videos/api.php?link=',  // 接口1 - 聚合视频解析
  'https://xzdx.top/api/duan/?url=',                          // 接口2 - 小众独行短视频解析
  // 你可以继续添加其他接口，格式必须完整包含参数名（?link= 或 ?url=）
];

export default {
  async fetch(request, env, ctx) {
    // 处理CORS预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      const url = new URL(request.url);
      const targetUrl = url.searchParams.get('url');
      const apiIndexParam = url.searchParams.get('api'); // 序号（从1开始）或完整URL

      // 如果没有提供URL参数，返回API说明（含可用接口列表）
      if (!targetUrl) {
        const apiListInfo = API_LIST.map((api, index) => `${index + 1}. ${api}`).join('\n');
        return new Response(JSON.stringify({
          code: 400,
          msg: "请提供内容链接",
          usage: {
            example: "/?url=内容链接",
            optional: "/?url=内容链接&api=序号(1开始) 或 &api=自定义解析接口URL",
            available_apis: apiListInfo
          }
        }, null, 2), {
          headers: { 
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          },
        });
      }

      // 确定使用的解析接口URL
      let apiUrl;
      if (apiIndexParam) {
        // 检查是否为数字（序号）
        if (/^\d+$/.test(apiIndexParam)) {
          const index = parseInt(apiIndexParam, 10);
          if (index >= 1 && index <= API_LIST.length) {
            apiUrl = API_LIST[index - 1];
          } else {
            // 序号超出范围，返回错误JSON
            return new Response(JSON.stringify({
              code: 400,
              msg: "接口序号无效",
              available_apis: API_LIST.map((api, i) => `${i+1}: ${api}`)
            }, null, 2), {
              headers: { 
                'Content-Type': 'application/json;charset=UTF-8',
                'Access-Control-Allow-Origin': '*'
              },
              status: 400
            });
          }
        } else {
          // 如果不是数字，视为自定义URL
          apiUrl = apiIndexParam;
          // 确保URL末尾有必要的参数格式
          if (!apiUrl.includes('?') && !apiUrl.endsWith('?')) {
            apiUrl = apiUrl.endsWith('/') ? apiUrl + '?url=' : apiUrl + '/?url=';
          }
        }
      } else {
        // 未指定api，默认使用第一个接口
        apiUrl = API_LIST[0];
      }

      // 1. 调用解析接口
      // 构建完整的解析API URL - 注意：不同接口可能使用不同的参数名
      const parserApiUrl = `${apiUrl}${encodeURIComponent(targetUrl)}`;
      console.log(`调用解析接口: ${parserApiUrl}`);
      
      let parserResponse;
      let parserData;
      
      try {
        parserResponse = await fetch(parserApiUrl);
        parserData = await parserResponse.json();
      } catch (fetchError) {
        // 解析接口调用失败，直接返回失败JSON
        return new Response(JSON.stringify({
          code: 502,
          msg: "解析接口调用失败",
          error: fetchError.message,
          api_url: apiUrl,
          "元数据": {
            "原始接口": apiUrl,
            "原始链接": targetUrl,
            "原始响应": null,
            "标准化时间": getBeijingTime()
          }
        }, null, 2), {
          headers: { 
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          },
          status: 502
        });
      }

      // 检查解析接口返回的状态码（兼容不同接口的错误格式）
      const isSuccess = checkApiSuccess(parserData);
      
      // 无论成功失败，都保留原始数据到元数据
      const baseMetadata = {
        "原始接口": apiUrl,
        "原始链接": targetUrl,
        "原始响应": parserData, // 始终保留原始解析接口的完整JSON数据
        "标准化时间": getBeijingTime()
      };

      if (!isSuccess) {
        // 解析接口返回错误，直接返回原始失败信息（包含原始数据）
        return new Response(JSON.stringify({
          code: parserData.code || 500,
          msg: parserData.msg || parserData.message || "解析接口返回错误",
          data: parserData.data || null,
          "元数据": baseMetadata
        }, null, 2), {
          headers: { 
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          },
          status: 200
        });
      }

      // 2. 调用DeepSeek API标准化数据
      const standardizedData = await standardizeWithDeepSeek(parserData, targetUrl, apiUrl, env);

      // 检查标准化是否成功
      if (standardizedData.code && standardizedData.code !== 200) {
        // 标准化失败，返回错误JSON（同时保留原始数据）
        return new Response(JSON.stringify({
          ...standardizedData,
          "元数据": baseMetadata
        }, null, 2), {
          headers: { 
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          },
          status: 200
        });
      }

      // 3. 返回标准化的JSON（包含原始数据元数据）
      const finalResponse = {
        ...standardizedData,
        "元数据": {
          ...(standardizedData["元数据"] || {}),
          ...baseMetadata
        }
      };

      return new Response(JSON.stringify(finalResponse, null, 2), {
        headers: { 
          'Content-Type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        },
      });

    } catch (error) {
      return new Response(JSON.stringify({
        code: 500,
        msg: "服务器错误",
        error: error.message,
        "元数据": {
          "标准化时间": getBeijingTime()
        }
      }, null, 2), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        status: 500,
      });
    }
  },
};

/**
 * 检查API返回是否成功（兼容不同接口）
 */
function checkApiSuccess(data) {
  // 接口1的成功格式：code为200
  if (data.code === 200) return true;
  
  // 接口2的成功格式：根据实际响应判断
  // 你提供的示例中code=3表示参数缺失，所以成功时可能code为其他值
  // 如果有data字段且不为null，且没有错误信息，可能表示成功
  if (data.data && data.data !== null && !data.msg?.includes('失败') && !data.msg?.includes('错误')) {
    return true;
  }
  
  return false;
}

/**
 * 获取北京时间 (UTC+8)
 */
function getBeijingTime() {
  const now = new Date();
  // 转换为北京时间字符串 (ISO格式带时区)
  const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  return beijingTime.toISOString().replace('Z', '+08:00');
}

/**
 * 调用DeepSeek API标准化内容数据
 */
async function standardizeWithDeepSeek(parserData, originalUrl, apiUrl, env) {
  try {
    // 从环境变量中获取DeepSeek API密钥
    const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
    const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
    
    // 检查API密钥是否存在
    if (!DEEPSEEK_API_KEY) {
      throw new Error('DeepSeek API密钥未配置');
    }

    const prompt = `
你是一个内容解析数据标准化助手。请将以下任意内容解析API返回的数据，转换为统一的JSON格式。

【原始链接】${originalUrl}
【解析接口】${apiUrl}
【原始返回数据】
${JSON.stringify(parserData, null, 2)}

请分析原始数据的内容类型（视频/图集/图片/图文/其他），并转换为以下统一的JSON格式。**重要：没有值的字段直接省略，不要包含在输出中**：

{
  "code": 200,
  "msg": "success",
  "数据": {
    // 基础信息（总是存在）
    "内容ID": "内容唯一ID",
    "内容类型": "video|gallery|image|article|other",  // 自动识别
    "标题": "标题",
    "描述": "描述",
    "平台": "来源平台",
    "发布时间": "发布时间戳",
    
    // 媒体内容（只放实际存在的）
    "视频列表": [  // 只有有视频时才包含
      {
        "地址": "视频播放地址",
        "画质": "HD/LD/SD",
        "格式": "mp4/m3u8",
        "时长": 0,
        "大小": 0
      }
    ],
    "图片列表": [  // 只有有图片时才包含
      {
        "地址": "图片地址",
        "宽度": 0,
        "高度": 0,
        "大小": 0,
        "格式": "jpg/png"
      }
    ],
    "封面": "封面图片URL",  // 视频封面或图集首图
    "总数": 0,  // 图集图片总数
    
    // 作者信息（只放实际存在的）
    "作者": {
      "ID": "作者ID",
      "名称": "作者名称",
      "昵称": "作者昵称",
      "用户名": "作者用户名",
      "头像": "作者头像URL",
      "签名": "作者签名",
      "粉丝数": 0,
      "关注数": 0
    },
    
    // 统计数据（只放实际存在的）
    "统计": {
      "点赞数": 0,
      "评论数": 0,
      "分享数": 0,
      "收藏数": 0,
      "播放数": 0,
      "浏览数": 0,
      "下载数": 0
    },
    
    // 互动信息（只放实际存在的）
    "互动": {
      "已点赞": false,
      "已关注": false,
      "已收藏": false
    },
    
    // 标签（只放实际存在的）
    "标签": ["标签1", "标签2"],
    
    // 位置信息（只放实际存在的）
    "位置": {
      "名称": "地点名称",
      "地址": "详细地址",
      "城市": "城市",
      "国家": "国家",
      "坐标": {
        "纬度": 0,
        "经度": 0
      }
    },
    
    // 音乐信息（只放实际存在的）
    "音乐": {
      "ID": "音乐ID",
      "名称": "音乐名称",
      "作者": "音乐作者",
      "地址": "音乐播放地址",
      "封面": "音乐封面"
    },
    
    // 其他特殊字段（只放实际存在的）
    "其他": {}
  }
}

严格要求：
1. **只输出有值的字段**：如果某个字段在原始数据中不存在，就不要在输出中包含它
2. 分析原始数据，自动识别内容类型
3. 字段名必须用中文，如"视频列表"而不是"videos"
4. 只返回JSON，不要有任何其他文字
5. 确保JSON格式正确，所有引号都闭合
`;

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一个智能JSON数据标准化助手。分析输入数据，自动识别内容类型，智能映射字段，只输出有值的字段，使用中文键名。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 3000,
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API请求失败: ${response.status}`);
    }

    const result = await response.json();
    const analysisText = result.choices[0].message.content;
    
    // 清理并解析JSON
    try {
      // 移除可能的Markdown代码块标记
      const cleanedText = analysisText.replace(/```json\n?|```\n?/g, '').trim();
      const parsedData = JSON.parse(cleanedText);
      
      // 注意：元数据会在外层统一添加，这里不再重复添加
      return parsedData;
      
    } catch (e) {
      // JSON解析失败，返回错误信息
      return {
        code: 500,
        msg: "数据标准化失败 - JSON解析错误",
        error: e.message,
        debug: {
          ai_response: analysisText
        }
      };
    }

  } catch (error) {
    console.error('DeepSeek标准化失败:', error);
    return {
      code: 500,
      msg: "AI服务暂时不可用",
      error: error.message
    };
  }
}