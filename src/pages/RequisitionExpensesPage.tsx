import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const RequisitionExpensesPage = () => {
  return (
    <div className="space-y-6">
      <Card className="border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Requisition Expenses</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-600">
          This page is not available yet. Use the requisition and trends pages while the expenses view is being restored.
        </CardContent>
      </Card>
    </div>
  );
};

export default RequisitionExpensesPage;
