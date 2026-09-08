require('dotenv').config();
const { prisma } = require('./db/prisma');
const { withoutTenantScope } = require('./utils/tenantContext');
withoutTenantScope(async () => {
  const clients = await prisma.client.findMany();
  console.log('clients', clients.map(c => ({ clientId: c.clientId, slug: c.slug, name: c.companyName, status: c.status })));
  const vendors = await prisma.vendor.findMany();
  console.log('vendors', vendors.map(v => ({ clientId: v.clientId, vendorId: v.vendorId, email: v.email, status: v.status, sap: v.sapVendorCode, company: v.companyName })));
  for (const m of ['rFQ','purchaseOrder','aSN','gRN','invoice','payment','sapLog','chatMessage','user']) {
    console.log(m, await prisma[m].count());
  }
}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
