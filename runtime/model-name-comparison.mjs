/** 只比较已提供的名称；不推断别名、模型身份或实际切换。 */
export function modelNameComparison(requestModel, responseModel) {
  if (!requestModel?.trim() || !responseModel?.trim()) return "信息不足";
  return requestModel.trim() === responseModel.trim() ? "名称一致" : "名称不一致";
}
