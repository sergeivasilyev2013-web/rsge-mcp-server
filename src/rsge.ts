import axios from "axios";
import { parseStringPromise } from "xml2js";

const WSDL_URL = "http://services.rs.ge/WayBillService/WayBillService.asmx";
export const SELLER_TIN = process.env.SELLER_TIN || "345685902";

function getSU() { return (process.env.RS_SERVICE_USER || "").split(":")[0]; }
function getSP() { return process.env.RS_SERVICE_PASSWORD || ""; }

async function soapCall(action: string, bodyXml: string): Promise<any> {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:rs="http://tempuri.org/">
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;
  const response = await axios.post(WSDL_URL, envelope, {
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": `http://tempuri.org/${action}` },
    timeout: 30000,
  });
  const parsed = await parseStringPromise(response.data, { explicitArray: false });
  return parsed["soap:Envelope"]["soap:Body"];
}

export async function rsCreateWaybill(buyerTin: string, buyerName: string, items: Array<{name: string; quantity: number; price: number}>, deliveryDate: string): Promise<string> {
  const goodsXml = items.map((item, i) => `<rs:WayBillGoods><rs:rowIndex>${i}</rs:rowIndex><rs:name>${item.name}</rs:name><rs:quantity>${item.quantity}</rs:quantity><rs:unitOfQty>პ</rs:unitOfQty><rs:price>${item.price}</rs:price></rs:WayBillGoods>`).join("");
  const bodyXml = `<rs:AddWayBill><rs:userName>${getSU()}</rs:userName><rs:password>${getSP()}</rs:password><rs:wayBill><rs:type>1</rs:type><rs:status>0</rs:status><rs:seller_id>${SELLER_TIN}</rs:seller_id><rs:buyer_id>${buyerTin}</rs:buyer_id><rs:buyerName>${buyerName}</rs:buyerName><rs:createDate>${deliveryDate}</rs:createDate><rs:transportType>0</rs:transportType><rs:waybillGoods>${goodsXml}</rs:waybillGoods></rs:wayBill></rs:AddWayBill>`;
  const result = await soapCall("AddWayBill", bodyXml);
  const resp = result["AddWayBillResponse"]?.["AddWayBillResult"];
  if (resp?.["errorCode"] && String(resp["errorCode"]) !== "0") throw new Error(`rs.ge ошибка: ${resp["errorMsg"]}`);
  return String(resp?.["waybillId"] || "unknown");
}

export async function rsLookupTin(tin: string): Promise<string> {
  const bodyXml = `<rs:GetPersonNameByIdOrganization><rs:user>${getSU()}</rs:user><rs:password>${getSP()}</rs:password><rs:tin>${tin}</rs:tin></rs:GetPersonNameByIdOrganization>`;
  const result = await soapCall("GetPersonNameByIdOrganization", bodyXml);
  return result["GetPersonNameByIdOrganizationResponse"]?.["GetPersonNameByIdOrganizationResult"] || "";
}
